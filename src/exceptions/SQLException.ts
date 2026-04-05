
export class SQLException extends Error {
  constructor(message: string, public info?: unknown, public db?: string) {
    super(message);
    this.name = "SQLException";
    this.db = db;
    this.info = info;

  }
}