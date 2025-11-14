export interface WebSocketEvent {
  requestContext: {
    connectionId: string;
    domainName: string;
    stage: string;
    apiId: string;
    routeKey: string;
    identity?: {
      sourceIp: string;
      userAgent?: string;
    };
  };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface WebSocketResponse {
  statusCode: number;
  body?: string;
}

export interface ConnectionItem {
  connectionId: string;
  connectedAt: number;
  ttl: number;
}

export interface MessageBody {
  action?: string;
  data?: string; // Base64エンコードされたファイルデータ
  fileName?: string;
  contentType?: string;
  [key: string]: any;
}

export interface WebSocketMessage {
  type: string;
  message?: string;
  data?: any;
  error?: string;
}
