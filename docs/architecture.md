# CounterBridge Architecture

## System Overview

```mermaid
graph TB
    subgraph Application["Application Layer"]
        APP[Your App / API Server]
    end

    subgraph SDK["@counter-bridge/sdk"]
        CLIENT[CounterClient]
        CLIENT -- "inc / dec / add" --> XADD
        XADD["XADD MAXLEN ~100k *<br/>scope, delta, timestamp, metadata"]
    end

    subgraph Redis["Redis"]
        STREAM[("Redis Stream<br/><code>counter-bridge:events</code>")]
        CG["Consumer Group<br/><code>counter-bridge-group</code>"]
        PEL["Pending Entries List<br/>(crash recovery)"]
        STREAM --- CG
        CG --- PEL
    end

    subgraph Core["@counter-bridge/core"]
        BRIDGE[CounterBridge]

        subgraph Startup["Startup Sequence"]
            INIT["provider.initialize()"]
            XGROUP["XGROUP CREATE"]
            RECOVER["recoverPending()<br/>XREADGROUP ID=0"]
        end

        subgraph Runtime["Runtime Loop"]
            READLOOP["readLoop()<br/>XREADGROUP BLOCK ID=>"]
            TIMER["scheduleFlush()<br/>every 500ms"]
        end

        AGG["Aggregator<br/><i>In-memory delta folding</i><br/>Map&lt;scope, netDelta&gt;"]

        subgraph FlushPipeline["Flush Pipeline (mutex-guarded)"]
            DRAIN["drain() batch"]
            FLUSH_PROVIDER["provider.flush(batch)"]
            PARTIAL{"Partial<br/>failure?"}
            READD["Re-add failed<br/>scopes only"]
            XACK["XACK message IDs"]
        end
    end

    subgraph Types["@counter-bridge/types"]
        IFACE["ICounterProvider<br/><i>interface</i>"]
    end

    subgraph ProviderMongo["@counter-bridge/provider-mongo"]
        MONGO_PROVIDER[MongoProvider]
        BULKWRITE["bulkWrite ordered:false<br/>$inc upsert per scope"]
        PLUGIN["counterPlugin<br/><i>Mongoose schema plugin</i><br/>inc / dec / add (write)<br/>getCounter / getCounters (read)"]
        SCHEMA[("counters collection<br/>{ scope, value, metadata }")]
    end

    subgraph DB["MongoDB"]
        MONGODB[("MongoDB")]
    end

    subgraph Future["Future Providers"]
        PG["PostgresProvider"]
        DYNAMO["DynamoProvider"]
        CUSTOM["YourProvider"]
    end

    subgraph ConsumerService["@counter-bridge/consumer"]
        SVC["Standalone Service<br/><i>Docker + Helm deployable</i>"]
        CONFIG["YAML Config + ENV overrides"]
        HEALTH["Health endpoint /healthz"]
        SIGNALS["Graceful shutdown<br/>SIGTERM / SIGINT"]
    end

    %% Consumer Service wiring
    SVC --> BRIDGE
    CONFIG --> SVC
    HEALTH --> SVC
    SIGNALS --> SVC

    %% Plugin write path
    PLUGIN -->|"inc/dec/add via<br/>counterBridge.setup()"| CLIENT

    %% Application → SDK
    APP -->|"counter.inc('v1:post:123:likes')"| CLIENT

    %% SDK → Redis
    XADD -->|"XADD"| STREAM

    %% Redis → Core (startup)
    INIT --> XGROUP
    XGROUP -->|"CREATE ... MKSTREAM"| CG
    RECOVER -->|"XREADGROUP ID=0"| PEL
    XGROUP --> RECOVER

    %% Redis → Core (runtime)
    STREAM -->|"XREADGROUP BLOCK"| READLOOP

    %% Core internal flow
    READLOOP --> AGG
    RECOVER --> AGG
    TIMER -->|"if size > 0"| DRAIN
    READLOOP -->|"if size >= maxBatch"| DRAIN
    AGG --> DRAIN
    DRAIN --> FLUSH_PROVIDER
    FLUSH_PROVIDER --> PARTIAL
    PARTIAL -->|"yes"| READD
    READD --> AGG
    PARTIAL -->|"no"| XACK
    XACK -->|"XACK"| CG

    %% Provider interface
    IFACE -.-|"implements"| MONGO_PROVIDER
    IFACE -.-|"implements"| PG
    IFACE -.-|"implements"| DYNAMO
    IFACE -.-|"implements"| CUSTOM

    %% Core → Provider
    FLUSH_PROVIDER -->|"flush(Map&lt;scope,delta&gt;)"| MONGO_PROVIDER

    %% MongoProvider → MongoDB
    MONGO_PROVIDER --> BULKWRITE
    BULKWRITE --> MONGODB
    PLUGIN -->|"getCounter() / withCounters()"| MONGO_PROVIDER
    MONGODB --- SCHEMA

    %% Read path
    APP -.->|"bridge.get('v1:post:123:likes')"| BRIDGE
    BRIDGE -.->|"provider.get(scope)"| MONGO_PROVIDER

    %% Styling
    classDef sdkStyle fill:#4a9eff,stroke:#2670c2,color:#fff
    classDef coreStyle fill:#ff9f43,stroke:#c77a30,color:#fff
    classDef redisStyle fill:#dc3545,stroke:#a82835,color:#fff
    classDef mongoStyle fill:#4db33d,stroke:#3a8c2e,color:#fff
    classDef typeStyle fill:#8b5cf6,stroke:#6d45c4,color:#fff
    classDef futureStyle fill:#6c757d,stroke:#545b62,color:#fff

    class CLIENT,XADD sdkStyle
    class BRIDGE,AGG,READLOOP,TIMER,DRAIN,FLUSH_PROVIDER,PARTIAL,READD,XACK,INIT,XGROUP,RECOVER coreStyle
    class STREAM,CG,PEL redisStyle
    class MONGO_PROVIDER,BULKWRITE,PLUGIN,SCHEMA mongoStyle
    class IFACE typeStyle
    class PG,DYNAMO,CUSTOM futureStyle
    class SVC,CONFIG,HEALTH,SIGNALS coreStyle
```

## At-Least-Once Delivery Guarantee

```mermaid
sequenceDiagram
    participant SDK as CounterClient
    participant RS as Redis Stream
    participant CB as CounterBridge
    participant AGG as Aggregator
    participant P as Provider (Mongo)
    participant DB as MongoDB

    Note over SDK,DB: Write Path (Producer)
    SDK->>RS: XADD scope=post:1:likes delta=1
    SDK->>RS: XADD scope=post:1:likes delta=1
    SDK->>RS: XADD scope=post:1:views delta=1

    Note over SDK,DB: Consume + Aggregate
    RS->>CB: XREADGROUP (3 messages)
    CB->>AGG: add({scope: post:1:likes, delta: 1})
    CB->>AGG: add({scope: post:1:likes, delta: 1})
    CB->>AGG: add({scope: post:1:views, delta: 1})
    Note over AGG: Folded state:<br/>post:1:likes → +2<br/>post:1:views → +1

    Note over SDK,DB: Flush (timer or batch-size trigger)
    CB->>AGG: drain()
    AGG-->>CB: Map{ likes: 2, views: 1 }
    CB->>P: flush(batch)
    P->>DB: bulkWrite [<br/>  $inc likes +2,<br/>  $inc views +1<br/>] ordered:false
    DB-->>P: OK
    P-->>CB: void (success)
    CB->>RS: XACK (3 message IDs)
    Note over RS: Messages removed from PEL

    Note over SDK,DB: Read Path
    SDK->>CB: get('post:1:likes')
    CB->>P: get('post:1:likes')
    P->>DB: findOne({scope: 'post:1:likes'})
    DB-->>P: {value: 2}
    P-->>CB: 2
    CB-->>SDK: 2
```

## Crash Recovery (PEL)

```mermaid
sequenceDiagram
    participant RS as Redis Stream
    participant CB as CounterBridge
    participant P as Provider

    Note over RS,P: Consumer crashes after XREADGROUP<br/>but before XACK — messages stay in PEL

    Note over RS,P: On Restart
    CB->>RS: XREADGROUP GROUP ... ID=0<br/>(read pending entries)
    RS-->>CB: Unacked messages from PEL
    CB->>CB: Aggregate recovered messages
    CB->>P: flush(recovered batch)
    P-->>CB: OK
    CB->>RS: XACK (recovered IDs)
    Note over RS: PEL cleared

    CB->>RS: XREADGROUP GROUP ... ID=><br/>(switch to new messages)
    Note over RS,P: Normal operation resumes
```

## Partial Flush Failure Handling

```mermaid
sequenceDiagram
    participant CB as CounterBridge
    participant AGG as Aggregator
    participant P as MongoProvider
    participant DB as MongoDB

    CB->>AGG: drain()
    AGG-->>CB: Map{ a: 1, b: 2, c: 3 }

    CB->>P: flush(batch)
    P->>DB: bulkWrite [$inc a, $inc b, $inc c]
    DB-->>P: MongoBulkWriteError<br/>(op[1] failed — scope 'b')

    P->>P: Inspect writeErrors<br/>partial: 1 of 3 failed
    P-->>CB: FlushResult{ failed: Map{ b: 2 } }

    CB->>CB: Re-add failed scopes to aggregator
    CB->>AGG: add({scope: b, delta: 2})
    CB->>RS: XACK all IDs (a & c persisted)

    Note over CB,AGG: Scope 'b' will be retried<br/>in the next flush cycle
```

## Plugin Write Flow

```mermaid
sequenceDiagram
    participant App as Application
    participant Doc as Mongoose Document
    participant Plugin as counterPlugin
    participant Setup as counterBridge.setup()
    participant Client as CounterClient
    participant RS as Redis Stream

    Note over App,RS: App Startup
    App->>Setup: counterBridge.setup({ redisUrl })
    Setup->>Client: new CounterClient({ redis })

    Note over App,RS: Write Path (via plugin)
    App->>Doc: post.inc('likes')
    Doc->>Plugin: this.counterScope('likes')
    Plugin-->>Doc: 'v1:post:123:likes'
    Doc->>Setup: getClient()
    Setup-->>Doc: CounterClient instance
    Doc->>Client: client.inc('v1:post:123:likes')
    Client->>RS: XADD scope=v1:post:123:likes delta=1

    Note over App,RS: App Shutdown
    App->>Setup: counterBridge.shutdown()
    Setup->>Client: client.close()
```

## Package Dependency Graph

```mermaid
graph BT
    TYPES["@counter-bridge/types<br/><i>Shared interfaces</i>"]
    CORE["@counter-bridge/core<br/><i>Consumer + Aggregator</i>"]
    SDK["@counter-bridge/sdk<br/><i>Producer client</i>"]
    PMONGO["@counter-bridge/provider-mongo<br/><i>MongoDB provider + plugin</i>"]
    CONSUMER["@counter-bridge/consumer<br/><i>Standalone service</i>"]

    CORE --> TYPES
    SDK --> TYPES
    PMONGO --> TYPES
    PMONGO --> SDK
    CONSUMER --> CORE
    CONSUMER --> PMONGO
    CONSUMER --> TYPES

    CORE -.->|"runtime via<br/>ICounterProvider"| PMONGO

    classDef types fill:#8b5cf6,stroke:#6d45c4,color:#fff
    classDef core fill:#ff9f43,stroke:#c77a30,color:#fff
    classDef sdk fill:#4a9eff,stroke:#2670c2,color:#fff
    classDef mongo fill:#4db33d,stroke:#3a8c2e,color:#fff
    classDef consumer fill:#e74c3c,stroke:#c0392b,color:#fff

    class TYPES types
    class CORE core
    class SDK sdk
    class PMONGO mongo
    class CONSUMER consumer
```
