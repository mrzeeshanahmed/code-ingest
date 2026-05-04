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

export const CREATE_CODE_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  file_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  lineage TEXT,
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
  lineage TEXT,
  pii_detected INTEGER DEFAULT 0,
  pii_tags TEXT
);
`;

export const CREATE_KNOWLEDGE_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  summary TEXT,
  invariants TEXT,
  pii_detected INTEGER DEFAULT 0,
  pii_redacted_summary TEXT,
  created_at INTEGER,
  stale INTEGER DEFAULT 0
);
`;

export const CREATE_KNOWLEDGE_LINKS_TABLE = `
CREATE TABLE IF NOT EXISTS knowledge_links (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  source_chunk_id TEXT NOT NULL,
  PRIMARY KEY (knowledge_id, source_chunk_id)
);
`;

export const CREATE_TERMS_TABLE = `
CREATE TABLE IF NOT EXISTS terms (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL UNIQUE,
  frequency INTEGER DEFAULT 1
);
`;

export const CREATE_TERM_LINKS_TABLE = `
CREATE TABLE IF NOT EXISTS term_links (
  term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  PRIMARY KEY (term_id, node_id)
);
`;

export const CREATE_MODULE_SUMMARIES_TABLE = `
CREATE TABLE IF NOT EXISTS module_summaries (
  id TEXT PRIMARY KEY,
  module_path TEXT NOT NULL UNIQUE,
  summary TEXT,
  file_count INTEGER DEFAULT 0,
  source_merkle_root TEXT,
  created_at INTEGER,
  stale INTEGER DEFAULT 0
);
`;

export const CREATE_DIRECTORY_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS directory_state (
  relative_path TEXT PRIMARY KEY,
  parent_relative_path TEXT,
  merkle_hash TEXT NOT NULL,
  child_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const CREATE_INDEX_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS index_state (
  workspace_hash TEXT PRIMARY KEY,
  last_full_index INTEGER,
  node_count INTEGER,
  edge_count INTEGER,
  schema_version INTEGER NOT NULL,
  git_head TEXT
);
`;

export const CREATE_EMBEDDING_DOCUMENT_METADATA_TABLE = `
CREATE TABLE IF NOT EXISTS embedding_document_metadata (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  last_embedded INTEGER
);
`;

export const CREATE_ARTIFACT_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS artifact_state (
  artifact_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  backend TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  doc_count INTEGER,
  updated_at INTEGER
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
  CREATE_CODE_CHUNKS_TABLE,
  CREATE_COMMENT_CHUNKS_TABLE,
  CREATE_KNOWLEDGE_CHUNKS_TABLE,
  CREATE_KNOWLEDGE_LINKS_TABLE,
  CREATE_TERMS_TABLE,
  CREATE_TERM_LINKS_TABLE,
  CREATE_MODULE_SUMMARIES_TABLE,
  CREATE_DIRECTORY_STATE_TABLE,
  CREATE_INDEX_STATE_TABLE,
  CREATE_EMBEDDING_DOCUMENT_METADATA_TABLE,
  CREATE_ARTIFACT_STATE_TABLE
];

export const ALL_DDL = CORE_DDL;
