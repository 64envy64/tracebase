export interface RawRecord {
  id: string;
  raw: string;
}

export interface TransformedRecord {
  id: string;
  normalized: string;
  ts: number;
}

export interface PipelineReport {
  fetched: number;
  transformed: number;
  written: number;
}
