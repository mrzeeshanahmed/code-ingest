require("ts-node/register");
const { JsonFormatter } = require("../src/formatters/jsonFormatter");
const { createFormatterDigestFixture } = require("../src/test/support/formatters.fixture");

const digest = createFormatterDigestFixture();
const output = new JsonFormatter().finalize(digest);
const match = output.match(/"content": "([^"]*)"/);
if (match) {
  const content = match[1];
  console.log(content);
  console.log(content.split("").map((char) => char.charCodeAt(0)));
}
