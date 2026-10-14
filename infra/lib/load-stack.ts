import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DataStack } from "./data-stack.js";

// Phase 7: k6 as a one-off Fargate task in the same region (synced clock, real bandwidth), hitting the public
// CloudFront URL like any client. It signs its own access tokens with the JWT secret, injected by ECS from SSM,
// because 500 logins from one IP trip the 5-per-15-min login limit. Run: deploy/aws/load-test.ps1.
// Costs nothing while idle (no service, just a task definition); delete the stack when done.
export class LoadStack extends Stack {
  constructor(scope: Construct, id: string, { data, ...props }: StackProps & { data: DataStack }) {
    super(scope, id, props);
    const cluster = new ecs.Cluster(this, "Cluster", { vpc: data.vpc });
    const logGroup = new logs.LogGroup(this, "K6Logs", { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY });
    const task = new ecs.FargateTaskDefinition(this, "K6Task", { cpu: 2048, memoryLimitMiB: 4096 });
    task.addContainer("k6", {
      image: ecs.ContainerImage.fromRegistry("grafana/k6:0.54.0"),
      // The script arrives per run (gzip + base64 env override, under ECS's 8 KB override limit), so editing it
      // needs no redeploy.
      entryPoint: ["sh", "-c", 'echo "$K6_SCRIPT_GZ" | base64 -d | gunzip > /tmp/board.k6.js && k6 run --quiet /tmp/board.k6.js'],
      secrets: {
        JWT_ACCESS_SECRET: ecs.Secret.fromSsmParameter(
          ssm.StringParameter.fromSecureStringParameterAttributes(this, "JwtAccess", { parameterName: "/pulseboard/jwt-access-secret" }),
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "k6", logGroup }),
    });
    const sg = new ec2.SecurityGroup(this, "K6Sg", { vpc: data.vpc, description: "k6 load generator, egress only" });

    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "TaskDef", { value: task.taskDefinitionArn });
    new CfnOutput(this, "LogGroup", { value: logGroup.logGroupName });
    new CfnOutput(this, "SecurityGroup", { value: sg.securityGroupId });
    new CfnOutput(this, "Subnets", { value: data.vpc.publicSubnets.map((s) => s.subnetId).join(",") });
  }
}
