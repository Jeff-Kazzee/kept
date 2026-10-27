// Live evaluation of extraction against the fixture corpus: three runs at
// reasoning effort low and three at minimal. Needs MODEL_API_KEY in the
// environment. Never prints the key. See src/eval/cli.ts for options.
import { main } from "../src/eval/cli.ts";

process.exitCode = await main(process.argv.slice(2), process.env);
