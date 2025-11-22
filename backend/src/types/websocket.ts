export interface ConnectionItem {
  connectionId: string;
  connectedAt: number;
  ttl: number;
}

export interface MessageBody {
  action?: string;
  data?: string; // Base64エンコードされたファイルデータ
  contentType?: string;
  [key: string]: any;
}

export interface WebSocketMessage {
  type: string;
  message?: string;
  data?: any;
  error?: string;
}
