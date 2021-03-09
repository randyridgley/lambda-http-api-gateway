#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { LambdaHttpApiStack } from '../lib/lambda-http-api-stack';

const app = new cdk.App();
new LambdaHttpApiStack(app, 'LambdaHttpApiStack');
