import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

const GITHUB_REPO = "puravbhatt0504/pulseboard";

// Long-lived resources: network, data stores, image repos, CI role. Deployable without Docker.
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly apiSg: ec2.SecurityGroup;
  readonly db: rds.DatabaseInstance;
  readonly redisHost: string;
  readonly redisPort: string;
  readonly bucket: s3.Bucket;
  readonly apiRepo: ecr.Repository;
  readonly webRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ponytail: no NAT (~$35/mo saved). Tasks run in public subnets with public IPs, locked down by SGs.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Owned here so the DB/Redis rules can reference it without a cross-stack cycle.
    this.apiSg = new ec2.SecurityGroup(this, "ApiTasksSg", { vpc: this.vpc, description: "PulseBoard api tasks" });

    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc: this.vpc, allowAllOutbound: false, description: "PulseBoard Postgres" });
    dbSg.addIngressRule(this.apiSg, ec2.Port.tcp(5432), "api tasks");
    this.db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      databaseName: "pulseboard",
      // URL-reserved characters excluded so the api can splice the password into DATABASE_URL unencoded.
      credentials: rds.Credentials.fromGeneratedSecret("pulseboard", { excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\=,." }),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      backupRetention: Duration.days(1),
      deletionProtection: false,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    // ponytail: single node, no TLS/AUTH; reachable only from the api SG inside isolated subnets.
    const redisSg = new ec2.SecurityGroup(this, "RedisSg", { vpc: this.vpc, allowAllOutbound: false, description: "PulseBoard Redis" });
    redisSg.addIngressRule(this.apiSg, ec2.Port.tcp(6379), "api tasks");
    const redisSubnets = new elasticache.CfnSubnetGroup(this, "RedisSubnets", {
      description: "PulseBoard Redis",
      subnetIds: this.vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const redis = new elasticache.CfnCacheCluster(this, "Redis", {
      engine: "redis",
      engineVersion: "7.1",
      cacheNodeType: "cache.t4g.micro",
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnets.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    });
    this.redisHost = redis.attrRedisEndpointAddress;
    this.redisPort = redis.attrRedisEndpointPort;

    // Presigned PUTs come straight from browsers; the signature, not CORS, is the access control.
    this.bucket = new s3.Bucket(this, "Attachments", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: ["*"], allowedHeaders: ["*"], maxAge: 3000 }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const repo = (name: string) =>
      new ecr.Repository(this, `${name}Repo`, {
        repositoryName: `pulseboard-${name}`,
        imageScanOnPush: true,
        lifecycleRules: [{ maxImageCount: 20 }],
        removalPolicy: RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      });
    this.apiRepo = repo("api");
    this.webRepo = repo("web");

    // CI deploy role: GitHub Actions OIDC, main branch of this repo only, no static keys.
    const github = new iam.OidcProviderNative(this, "GithubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });
    const deployRole = new iam.Role(this, "GithubDeployRole", {
      assumedBy: new iam.WebIdentityPrincipal(github.oidcProviderArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:ref:refs/heads/main`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    // `cdk deploy` works by assuming the bootstrap roles; ECR push for the images.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
      }),
    );
    this.apiRepo.grantPullPush(deployRole);
    this.webRepo.grantPullPush(deployRole);
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));

    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn, description: "GitHub repo variable AWS_DEPLOY_ROLE_ARN" });
  }
}
