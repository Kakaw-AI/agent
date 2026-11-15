export type AnswerPromptInput = {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

export type ChartPlanPromptInput = {
  question: string;
  columns: string[];
  numericColumns: string[];
  labelColumns: string[];
  rows: Array<Record<string, unknown>>;
};

export type SuggestionsPromptInput = {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  tableNames: string;
  summary: string;
};
