// @synatic/noql ships JavaScript only. This covers the one call the agent makes.
declare module "@synatic/noql" {
  const NoQL: {
    makeMongoAggregate(
      sql: string,
      options?: { unsetId?: boolean },
    ): { collections: string[]; pipeline: Array<Record<string, unknown>>; type: "aggregate" };
  };
  export default NoQL;
}
