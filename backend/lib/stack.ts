import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export class WsStreamingUploadStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stage = this.node.tryGetContext("stage") || "dev";
    const service = "ws-streaming-upload";

    // VPC の作成（NAT Gatewayなし）
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // DynamoDB テーブル
    const connectionsTable = new dynamodb.Table(this, "ConnectionsTable", {
      tableName: `${service}-connections-${stage}`,
      partitionKey: {
        name: "connectionId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // S3 バケット
    const s3Bucket = new s3.Bucket(this, "S3Bucket", {
      bucketName: `${service}-${stage}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ECS クラスター
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `${service}-cluster-${stage}`,
      containerInsights: true,
    });

    // タスク実行ロール
    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // タスクロール（アプリケーション用）
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // DynamoDB へのアクセス権限
    connectionsTable.grantReadWriteData(taskRole);

    // S3 へのアクセス権限
    s3Bucket.grantReadWrite(taskRole);

    // ECS タスク用のセキュリティグループ
    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSecurityGroup", {
      vpc,
      description: "Security group for ECS tasks",
      allowAllOutbound: true,
    });

    // VPC エンドポイント（コスト削減とセキュリティ向上）
    // S3 用の Gateway エンドポイント
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // DynamoDB 用の Gateway エンドポイント
    vpc.addGatewayEndpoint("DynamoDbEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // CloudWatch Logs 用の Interface エンドポイント
    // プライベートサブネットに配置する必要がある
    const cloudWatchLogsEndpoint = vpc.addInterfaceEndpoint(
      "CloudWatchLogsEndpoint",
      {
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        subnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      }
    );

    // ECR API 用の Interface エンドポイント（イメージの認証・メタデータ取得用）
    const ecrApiEndpoint = vpc.addInterfaceEndpoint("EcrApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ECR Docker レジストリ用の Interface エンドポイント（イメージプル用）
    const ecrDkrEndpoint = vpc.addInterfaceEndpoint("EcrDkrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // CloudWatch Logs エンドポイントのセキュリティグループに
    // ECS タスクからのアクセスを許可
    cloudWatchLogsEndpoint.connections.allowFrom(
      taskSecurityGroup,
      ec2.Port.tcp(443),
      "Allow ECS tasks to send logs to CloudWatch Logs"
    );

    // ECR API エンドポイントのセキュリティグループに
    // ECS タスクからのアクセスを許可
    ecrApiEndpoint.connections.allowFrom(
      taskSecurityGroup,
      ec2.Port.tcp(443),
      "Allow ECS tasks to authenticate with ECR API"
    );

    // ECR Docker レジストリエンドポイントのセキュリティグループに
    // ECS タスクからのアクセスを許可
    ecrDkrEndpoint.connections.allowFrom(
      taskSecurityGroup,
      ec2.Port.tcp(443),
      "Allow ECS tasks to pull images from ECR"
    );

    // CloudWatch Logs グループ
    const logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/ecs/${service}-${stage}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    // ECS タスク定義
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "TaskDefinition",
      {
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: taskExecutionRole,
        taskRole: taskRole,
      }
    );

    // コンテナ定義
    // Dockerfile で --platform=linux/amd64 を指定しているため、
    // AWS Fargate (x86_64) と互換性がある
    const container = taskDefinition.addContainer("WebSocketContainer", {
      image: ecs.ContainerImage.fromAsset(".", {
        file: "Dockerfile",
      }),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "websocket",
        logGroup: logGroup,
      }),
      environment: {
        STAGE: stage,
        SERVICE: service,
        CONNECTIONS_TABLE: connectionsTable.tableName,
        S3_BUCKET_NAME: s3Bucket.bucketName,
        AWS_REGION: this.region,
        PORT: "3000",
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"require('http').get('http://localhost:3000/health', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));\""
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(20),
      }
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // Application Load Balancer（ECSサービスの前に作成）
    // パブリックサブネットに配置し、複数AZで高可用性を確保
    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      internetFacing: true,
      loadBalancerName: `${service}-alb-${stage}`,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC, // パブリックサブネットに明示的に配置
      },
    });

    // セキュリティグループ
    const albSecurityGroup = alb.connections.securityGroups[0];
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic"
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow HTTPS traffic"
    );

    // ターゲットグループ（ECSサービスの前に作成）
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10), // タイムアウトを延長（アプリケーション起動時間を考慮）
        healthyThresholdCount: 2, // 2回連続で成功したら正常と判定
        unhealthyThresholdCount: 3, // 3回連続で失敗したら異常と判定
        healthyHttpCodes: "200",
      },
    });

    // ALB から ECS タスクへのトラフィックを許可
    taskSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      "Allow traffic from ALB to ECS tasks"
    );

    // ECS サービス
    // 2つのプライベートサブネット（各AZ）にタスクを配置
    const fargateService = new ecs.FargateService(this, "FargateService", {
      cluster,
      taskDefinition,
      desiredCount: 2, // 各AZに1つずつタスクを配置
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // PRIVATE_ISOLATED サブネットを明示的に指定
      },
      securityGroups: [taskSecurityGroup],
      // ヘルスチェックの猶予期間（アプリケーション起動時間を考慮）
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // ターゲットグループにサービスを登録
    fargateService.attachToApplicationTargetGroup(targetGroup);

    // HTTP リスナー（WebSocket をサポート）
    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // デフォルトアクションとしてターゲットグループを追加
    listener.addTargetGroups("DefaultTargetGroup", {
      targetGroups: [targetGroup],
    });

    // 出力
    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: alb.loadBalancerDnsName,
      description: "Application Load Balancer DNS name",
      exportName: `${service}-${stage}-alb-dns`,
    });

    new cdk.CfnOutput(this, "WebSocketEndpoint", {
      value: `ws://${alb.loadBalancerDnsName}`,
      description: "WebSocket endpoint URL",
      exportName: `${service}-${stage}-websocket-endpoint`,
    });

    new cdk.CfnOutput(this, "ConnectionsTableName", {
      value: connectionsTable.tableName,
      description: "DynamoDB Connections Table Name",
      exportName: `${service}-${stage}-connections-table`,
    });

    new cdk.CfnOutput(this, "S3BucketName", {
      value: s3Bucket.bucketName,
      description: "S3 Bucket Name",
      exportName: `${service}-${stage}-s3-bucket`,
    });
  }
}
