export class EnvironmentConfigException extends Error {
  constructor(message: string, public variableName: string) {
    super(message);
    this.name = "EnvironmentConfigException";
    this.variableName = variableName;
  }
}