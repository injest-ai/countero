import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ICounterDocument extends Document {
  scope: string;
  value: number;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

const counterSchema = new Schema<ICounterDocument>(
  {
    scope: { type: String, required: true, unique: true, index: true },
    value: { type: Number, required: true, default: 0 },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    collection: 'counters',
  }
);

// Compound index for efficient lookups by metadata fields
counterSchema.index({ 'metadata.model': 1, 'metadata.entityId': 1 });

export function getCounterModel(
  connection?: mongoose.Connection,
  collectionName = 'counters'
): Model<ICounterDocument> {
  const modelName = `Counter_${collectionName}`;

  if (connection) {
    try {
      return connection.model<ICounterDocument>(modelName);
    } catch {
      const schema = counterSchema.clone();
      schema.set('collection', collectionName);
      return connection.model<ICounterDocument>(modelName, schema);
    }
  }

  // Use default mongoose connection
  try {
    return mongoose.model<ICounterDocument>(modelName);
  } catch {
    const schema = counterSchema.clone();
    schema.set('collection', collectionName);
    return mongoose.model<ICounterDocument>(modelName, schema);
  }
}
