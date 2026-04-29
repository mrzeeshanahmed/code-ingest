import { GRAPH_SCHEMA_VERSION } from "../../config/constants";

export const SCHEMA_VERSION = GRAPH_SCHEMA_VERSION;

export const CREATE_NODES_TABLE = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  file_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  language TEXT,
  last_indexed INTEGER NOT NULL,
  hash TEXT NOT NULL,
  metadata TEXT
);
`;

export const CREATE_NODES_RELATIVE_PATH_INDEX = `
CREATE INDEX IF NOT EXISTS nodes_relative_path_idx ON nodes(relative_path);
`;

export const CREATE_NODES_FILE_PATH_INDEX = `
CREATE INDEX IF NOT EXISTS nodes_file_path_idx ON nodes(file_path);
`;

export const CREATE_EDGES_TABLE = `
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata TEXT
);
`;

export const CREATE_EDGES_SOURCE_INDEX = `
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_id);
`;

export const CREATE_EDGES_TARGET_INDEX = `
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_id);
`;

export const CREATE_INDEX_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS index_state (
  workspace_hash TEXT PRIMARY KEY,
  last_full_index INTEGER,
  node_count INTEGER,
  edge_count INTEGER,
  schema_version INTEGER DEFAULT ${SCHEMA_VERSION}
);
`;

export const CREATE_NODE_EMBEDDINGS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings USING vec0(
  node_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);
`;

export const CREATE_NODE_EMBEDDINGS_FALLBACK_TABLE = `
CREATE TABLE IF NOT EXISTS node_embeddings_fallback (
  node_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL
);
`;

export const CREATE_CODE_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  file_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  pii_detected INTEGER DEFAULT 0,
  pii_redacted_content TEXT
);
`;

export const CREATE_COMMENT_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS comment_chunks (
  id TEXT PRIMARY KEY,
  file_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  pii_detected INTEGER DEFAULT 0,
  pii_tags TEXT
);
`;

export const CORE_DDL = [
  "PRAGMA journal_mode=WAL;",
  "PRAGMA foreign_keys=ON;",
  CREATE_NODES_TABLE,
  CREATE_NODES_RELATIVE_PATH_INDEX,
  CREATE_NODES_FILE_PATH_INDEX,
  CREATE_EDGES_TABLE,
  CREATE_EDGES_SOURCE_INDEX,
  CREATE_EDGES_TARGET_INDEX,
  CREATE_INDEX_STATE_TABLE,
  CREATE_CODE_CHUNKS_TABLE,
  CREATE_COMMENT_CHUNKS_TABLE
];

export const VEC_DDL = [CREATE_NODE_EMBEDDINGS_TABLE];

export const FALLBACK_DDL = [CREATE_NODE_EMBEDDINGS_FALLBACK_TABLE];

export const ALL_DDL = [...CORE_DDL, ...VEC_DDL];
