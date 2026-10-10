import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "../lib/app-stack.js";
import { DataStack } from "../lib/data-stack.js";

const app = new App();
const env = { account: "934846852308", region: "ap-south-1" };
Tags.of(app).add("project", "pulseboard");

const data = new DataStack(app, "PulseboardData", { env });

// Images are built and pushed by CI, so the app stack only exists when a tag is given:
//   npx cdk deploy PulseboardApp -c imageTag=<git sha>
const imageTag = app.node.tryGetContext("imageTag");
if (imageTag) new AppStack(app, "PulseboardApp", { env, data, imageTag });
