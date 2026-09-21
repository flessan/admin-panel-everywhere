/** Structural connector contract; documentation/editor types, no TypeScript runtime. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type DocumentData = { [key: string]: Json };
export interface RequestOptions { signal?: AbortSignal }
export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: string | null }
export interface RecordEnvelope {
  id: string;
  data: DocumentData;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}
export type CollectionSchema = DocumentData | DocumentData[];
export interface CollectionDescriptor {
  name: string;
  schema: CollectionSchema | null;
  schemaSource: 'configured' | 'remote' | 'unavailable';
}
export interface ApiResponse<T = unknown> { data: T; status: number; headers: Headers }
export interface Endpoint {
  id: string;
  method: string;
  path: string;
  operationId: string | null;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  security: Record<string, string[]>[];
  securitySchemes: Record<string, unknown>;
  warnings: string[];
  executable: boolean;
  parameters: unknown[];
  requestBody: unknown;
  responses: unknown;
}
/** Controlled lower-level API options; backend validates the complete schema. */
export interface ApiRequest extends RequestOptions {
  endpointId: string;
  pathParameters?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean>;
  headers?: HeadersInit;
  json?: Json;
  body?: BodyInit;
  responseType?: 'json' | 'blob' | 'text' | 'none';
  allowMutation?: boolean;
}
export interface RequestPreview {
  method: string;
  url: string;
  headers: Record<string, string>;
  authentication: 'bearer' | 'none';
  body: Json;
  bodyKind: 'json' | 'text' | 'binary' | 'none';
  bodyOmitted?: boolean;
}
export interface InspectedResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  data: Json;
  bodyKind: 'empty' | 'json' | 'text' | 'binary' | 'omitted';
  omitted: boolean;
}
export interface Discovery {
  discoverOpenApi(options?: RequestOptions & { refresh?: boolean }): Promise<DocumentData>;
  listEndpoints(options?: RequestOptions & { refresh?: boolean }): Promise<Endpoint[]>;
}
export interface FileEntry {
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface FileMetadata {
  bucket: string;
  key: string;
  size: number | null;
  contentType: string | null;
  etag: string | null;
  version: number | null;
  lastModified: string | null;
  acceptRanges: string | null;
  custom: Record<string, string>;
}
export interface Connection {
  readonly metadata: Readonly<{
    connector: string;
    baseUrl: string;
    managementUrl?: string;
    limits?: Readonly<{ objectBytes: number }>;
    project?: string;
    projectAuthorization: 'credential';
    capabilities: Readonly<{
      collectionDiscovery: 'configured' | 'remote' | 'unavailable';
      schemaDiscovery: 'configured' | 'remote' | 'unavailable';
      collectionManagement: boolean;
      documentCrud: boolean;
      storage: boolean;
      bucketDiscovery?: 'configured' | 'remote' | 'unavailable';
      openapi: boolean;
    }>;
  }>;
  readonly authentication: {
    readonly type: string;
    readonly configured: boolean;
    clear(): void;
  };
  readonly discovery: Discovery;
  readonly database: {
    listCollections(): Promise<{ items: CollectionDescriptor[]; source: string; complete: boolean }>;
    getCollection(name: string): Promise<CollectionDescriptor>;
    getCollectionSchema(name: string): Promise<{ schema: CollectionSchema | null; source: string }>;
    listRecords(collection: string, options?: RequestOptions & { limit?: number; cursor?: string; filters?: Record<string, string> }): Promise<Page<RecordEnvelope>>;
    getRecord(collection: string, id: string, options?: RequestOptions): Promise<RecordEnvelope>;
    createRecord(collection: string, data: DocumentData, options?: RequestOptions & { idempotencyKey?: string }): Promise<RecordEnvelope>;
    updateRecord(collection: string, id: string, changes: DocumentData, options: RequestOptions & { expectedVersion: number }): Promise<RecordEnvelope>;
    deleteRecord(collection: string, id: string, options: RequestOptions & { expectedVersion: number }): Promise<{ deleted: boolean; version: number | null; deletedAt: string | null }>;
  };
  readonly storage: {
    listBuckets?(): Promise<{ items: { name: string }[]; source: string; complete: boolean }>;
    getObjectUrl?(bucket: string, key: string): { url: string; requiresAuthentication: boolean };
    listObjects(bucket: string, options?: RequestOptions & { prefix?: string; delimiter?: string; limit?: number; cursor?: string }): Promise<Page<FileEntry> & { commonPrefixes: string[] }>;
    getObjectMetadata(bucket: string, key: string, options?: RequestOptions): Promise<FileMetadata>;
    downloadObject(bucket: string, key: string, options?: RequestOptions & { range?: string; ifMatch?: string; ifNoneMatch?: string }): Promise<ApiResponse<Blob | null>>;
    uploadObject(bucket: string, key: string, body: Blob | ArrayBuffer | ArrayBufferView, options?: RequestOptions & { contentType?: string; metadata?: Record<string, string> }): Promise<FileEntry>;
    deleteObject(bucket: string, key: string, options?: RequestOptions): Promise<{ deleted: boolean }>;
  };
  readonly api: Discovery & {
    /** Existing raw programmatic API: results may be sensitive. */
    execute(options: ApiRequest): Promise<ApiResponse>;
    /** Optional for legacy connectors; all tooling hooks enable safe UI execution. */
    inspect?(options: ApiRequest): Promise<InspectedResponse>;
    previewRequest?(options: ApiRequest): Promise<RequestPreview>;
    sanitize?(value: unknown): unknown;
    sanitizeDocument?(value: unknown): unknown;
  };
  disconnect(): void;
}
