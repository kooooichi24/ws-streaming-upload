import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

// DynamoDB Localは認証情報を無視しますが、AWS SDK v3では認証情報プロバイダーが必要です
// -sharedDbオプションを使用している場合、任意の認証情報で動作します
// handler.tsと同じ認証情報を使用します
const dynamoClient = new DynamoDBClient({
  region: "localhost",
  endpoint: "http://localhost:8000",
  credentials: {
    accessKeyId: "dummy",
    secretAccessKey: "dummy",
  },
});

const tableName =
  process.env.CONNECTIONS_TABLE || "ws-streaming-upload-connections-dev";

const createTable = async () => {
  const params: CreateTableCommandInput = {
    TableName: tableName,
    AttributeDefinitions: [
      {
        AttributeName: "connectionId",
        AttributeType: "S",
      },
    ],
    KeySchema: [
      {
        AttributeName: "connectionId",
        KeyType: "HASH",
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
    // TimeToLiveSpecificationはCreateTableでは設定できないため、後でUpdateTimeToLiveで設定
  } as CreateTableCommandInput;

  try {
    await dynamoClient.send(new CreateTableCommand(params));
    console.log(`✅ Table "${tableName}" created successfully`);
  } catch (error: any) {
    if (error.name === "ResourceInUseException") {
      console.log(`ℹ️  Table "${tableName}" already exists`);
    } else {
      console.error("❌ Error creating table:", error);
      process.exit(1);
    }
  }
};

createTable();
