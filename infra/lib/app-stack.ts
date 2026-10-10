import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DataStack } from "./data-stack.js";

type Props = StackProps & { data: DataStack; imageTag: string };

// Stateless compute: ALB + Fargate services + CloudFront. Redeployed by CI on every push to main.
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, { data, imageTag, ...props }: Props) {
    super(scope, id, props);
    const { vpc } = data;

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    const logDriver = (prefix: string) =>
      ecs.LogDrivers.awsLogs({ streamPrefix: prefix, logRetention: logs.RetentionDays.ONE_WEEK });

    // ALB only reachable from CloudFront, so the CloudFront URL is the single public entrypoint.
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "PulseBoard ALB" });
    const cloudfrontPrefixList = ec2.PrefixList.fromLookup(this, "CloudFrontOriginFacing", {
      prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
    });
    albSg.addIngressRule(ec2.Peer.prefixList(cloudfrontPrefixList.prefixListId), ec2.Port.tcp(80), "CloudFront");
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", { vpc, internetFacing: true, securityGroup: albSg });

    const distribution = new cloudfront.Distribution(this, "Cdn", {
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: this.behavior(alb, cloudfront.CachePolicy.CACHING_DISABLED),
      additionalBehaviors: {
        "/api/*": this.behavior(alb, cloudfront.CachePolicy.CACHING_DISABLED),
        "/socket.io/*": this.behavior(alb, cloudfront.CachePolicy.CACHING_DISABLED),
        "/_next/static/*": this.behavior(alb, cloudfront.CachePolicy.CACHING_OPTIMIZED),
      },
    });
    const publicUrl = `https://${distribution.distributionDomainName}`;

    // --- api: migrate init container, then the server (2 tasks, shared state via Redis) ---
    const api = new ecs.FargateTaskDefinition(this, "ApiTask", { cpu: 256, memoryLimitMiB: 512 });
    const dbSecret = data.db.secret!;
    const dbEnv = {
      DB_HOST: data.db.dbInstanceEndpointAddress,
      DB_PORT: data.db.dbInstanceEndpointPort,
      DB_NAME: "pulseboard",
    };
    const dbSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
    };
    const migrate = api.addContainer("migrate", {
      image: ecs.ContainerImage.fromEcrRepository(data.apiRepo, `${imageTag}-migrate`),
      essential: false,
      command: ["sh", "-c", 'DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" npx prisma migrate deploy'],
      environment: dbEnv,
      secrets: dbSecrets,
      logging: logDriver("migrate"),
    });
    const jwt = (name: string) =>
      ecs.Secret.fromSsmParameter(
        ssm.StringParameter.fromSecureStringParameterAttributes(this, name, { parameterName: `/pulseboard/${name}` }),
      );
    const server = api.addContainer("api", {
      image: ecs.ContainerImage.fromEcrRepository(data.apiRepo, imageTag),
      portMappings: [{ containerPort: 4000 }],
      environment: {
        ...dbEnv,
        NODE_ENV: "production",
        PORT: "4000",
        API_BASE_PATH: "/api",
        TRUST_PROXY_HOPS: "2", // client -> CloudFront -> ALB
        WEB_ORIGIN: publicUrl,
        PUBLIC_API_URL: `${publicUrl}/api`,
        REDIS_URL: `redis://${data.redisHost}:${data.redisPort}`,
        S3_BUCKET: data.bucket.bucketName,
        AWS_REGION: this.region,
      },
      secrets: {
        ...dbSecrets,
        JWT_ACCESS_SECRET: jwt("jwt-access-secret"),
        JWT_REFRESH_SECRET: jwt("jwt-refresh-secret"),
      },
      logging: logDriver("api"),
    });
    server.addContainerDependencies({ container: migrate, condition: ecs.ContainerDependencyCondition.SUCCESS });
    data.bucket.grantPut(api.taskRole);

    const apiService = new ecs.FargateService(this, "ApiService", {
      cluster,
      taskDefinition: api,
      desiredCount: 2,
      assignPublicIp: true, // no NAT: needs a public IP to reach ECR/SSM/Secrets Manager
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // Immutable import: stops addTargets() auto-adding an ALB rule to this Data-stack SG (a Data->App cycle).
      securityGroups: [ec2.SecurityGroup.fromSecurityGroupId(this, "ApiSg", data.apiSg.securityGroupId, { mutable: false })],
      minHealthyPercent: 50,
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });
    // ALB -> api rule declared explicitly in this stack (see the immutable import above).
    new ec2.CfnSecurityGroupIngress(this, "AlbToApi", {
      groupId: data.apiSg.securityGroupId,
      sourceSecurityGroupId: albSg.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 4000,
      toPort: 4000,
    });

    // --- web: Next.js standalone server ---
    const web = new ecs.FargateTaskDefinition(this, "WebTask", { cpu: 256, memoryLimitMiB: 512 });
    web.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(data.webRepo, imageTag),
      portMappings: [{ containerPort: 3000 }],
      environment: { NODE_ENV: "production", PORT: "3000", HOSTNAME: "0.0.0.0" },
      logging: logDriver("web"),
    });
    const webSg = new ec2.SecurityGroup(this, "WebTasksSg", { vpc, description: "PulseBoard web tasks" });
    webSg.addIngressRule(albSg, ec2.Port.tcp(3000), "ALB");
    const webService = new ecs.FargateService(this, "WebService", {
      cluster,
      taskDefinition: web,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [webSg],
      minHealthyPercent: 0,
      circuitBreaker: { rollback: true },
    });

    // --- routing: /api/* and /socket.io/* -> api, everything else -> web. No stickiness: websocket-only clients. ---
    const listener = alb.addListener("Http", { port: 80, open: false });
    listener.addTargets("Web", {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: { path: "/login" },
      deregistrationDelay: Duration.seconds(10),
    });
    listener.addTargets("Api", {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/api/*", "/socket.io/*"])],
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: { path: "/api/health" },
      deregistrationDelay: Duration.seconds(10),
    });

    new CfnOutput(this, "Url", { value: publicUrl });
  }

  private behavior(alb: elbv2.ApplicationLoadBalancer, cachePolicy: cloudfront.ICachePolicy): cloudfront.BehaviorOptions {
    return {
      origin: new origins.HttpOrigin(alb.loadBalancerDnsName, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };
  }
}
