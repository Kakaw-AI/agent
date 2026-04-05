export type QueryResult = {
  rowCount: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};
