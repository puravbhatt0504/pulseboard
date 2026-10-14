import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.js";
import { DataStack } from "../lib/data-stack.js";
import { LoadStack } from "../lib/load-stack.js";

const app = new App();
const env = { account: "934846852308", region: "ap-south-1" };
Tags.of(app).add("project", "pulseboard");

const data = new DataStack(app, "PulseboardData", { env });

// Images are built and pushed by CI, which deploys with the git sha:
//   npx cdk deploy PulseboardApp --exclusively -c imageTag=<sha>
// The app stack is always defined (placeholder tag otherwise) because its weak cross-stack references
// make PulseboardData publish the outputs it reads; synthesizing Data alone would drop them.
const imageTag = app.node.tryGetContext("imageTag") ?? "no-image-tag";
new AppStack(app, "PulseboardApp", { env, data, imageTag });

// Phase 7 load generator, deployed by hand only: npx cdk deploy PulseboardLoad --exclusively
new LoadStack(app, "PulseboardLoad", { env, data });
