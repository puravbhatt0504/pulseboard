import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

// Bedrock for the Render deploy (no task role there): an IAM user that can only call the two models.
// Outlives the App/Data stacks. Create its access key in the console and paste it into Render's env.
export class BedrockUserStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { models: string[] }) {
    super(scope, id, props);
    const user = new iam.User(this, "RenderBedrock", { userName: "pulseboard-render-bedrock" });
    user.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: props.models.map((m) => `arn:aws:bedrock:${this.region}::foundation-model/${m}`),
      }),
    );
    new CfnOutput(this, "UserName", { value: user.userName });
  }
}
