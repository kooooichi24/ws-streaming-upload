import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
} from "@aws-sdk/client-s3";

// MinIOクライアントの設定（ローカル環境）
const s3Client = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:9000",
  forcePathStyle: true, // MinIOでは必須
  credentials: {
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
});

const bucketName = process.env.S3_BUCKET_NAME || "ws-streaming-upload-dev";

const setupMinIO = async () => {
  try {
    // バケットの作成
    await s3Client.send(
      new CreateBucketCommand({
        Bucket: bucketName,
      })
    );
    console.log(`✅ Bucket "${bucketName}" created successfully`);
  } catch (error: any) {
    if (
      error.name === "BucketAlreadyExists" ||
      error.name === "BucketAlreadyOwnedByYou"
    ) {
      console.log(`ℹ️  Bucket "${bucketName}" already exists`);
    } else {
      console.error("❌ Error creating bucket:", error);
      process.exit(1);
    }
  }
};

setupMinIO();
