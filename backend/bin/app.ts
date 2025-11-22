#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { WsStreamingUploadStack } from "../lib/stack";

const app = new cdk.App();

new WsStreamingUploadStack(app, "WsStreamingUploadStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "ap-northeast-1",
  },
});
