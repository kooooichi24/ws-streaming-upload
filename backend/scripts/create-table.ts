import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

// DynamoDB Localは認証情報を必要としません
const dynamoClient = new DynamoDBClient({
  region: "localhost",
  endpoint: "http://localhost:8000",
  // credentialsは不要（DynamoDB Localは認証を無視します）
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
