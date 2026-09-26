// Retry/auth paths log progress to stderr by design (it is the MCP server's log). Keep test
// output readable; a test that needs the log can spy on console.error itself.
jest.spyOn(console, "error").mockImplementation(() => undefined);
