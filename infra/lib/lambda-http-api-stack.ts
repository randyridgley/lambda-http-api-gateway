import * as cdk from '@aws-cdk/core';
import * as apigw from '@aws-cdk/aws-apigatewayv2';
import * as apigwv1 from '@aws-cdk/aws-apigateway';
import * as apigwint from '@aws-cdk/aws-apigatewayv2-integrations';
import * as lambda from '@aws-cdk/aws-lambda';
import * as destinations from '@aws-cdk/aws-lambda-destinations';
import * as events from '@aws-cdk/aws-events';
import * as kinesis from '@aws-cdk/aws-kinesis';
import * as targets from '@aws-cdk/aws-events-targets'
import * as sns from '@aws-cdk/aws-sns'
import * as subscriptions from '@aws-cdk/aws-sns-subscriptions'
import * as path from 'path';
import * as s3 from '@aws-cdk/aws-s3';
import * as s3n from '@aws-cdk/aws-s3-notifications';
import * as codecommit from "@aws-cdk/aws-codecommit";
import * as amplify from "@aws-cdk/aws-amplify";

export class LambdaHttpApiStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const httpApi = this.createHttpApi();
    const restApi = this.createRestApi();

    const bucket = new s3.Bucket(this, 'StaticBucket');
    const topic = new sns.Topic(this, 'EventbusTopic');
    topic.addSubscription(new subscriptions.SmsSubscription('+17025758312'))

    const eventbus = new events.EventBus(this, "EventBus", {
      eventBusName: "lambdaDestinationsEventbus",
    });

    // const onSuccess = new destinations.EventBridgeDestination(eventbus);
    // const onFailure = new destinations.EventBridgeDestination(eventbus);

    // const lambdaDest = new lambda.Function(this, 'LifeCycleAuditor', {
    //   runtime: lambda.Runtime.NODEJS_10_X,
    //   handler: 'index.handler',
    //   code: new lambda.AssetCode('lambda-event-handler'),

    // });
    // bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(lambdaDest));

    const stream = new kinesis.Stream(this, 'KinesisStream');

    const kinesisTarget = new targets.KinesisStream(stream);
    const snsTopicTarget = new targets.SnsTopic(topic);

    new events.Rule(this, 'Push all events to kinesis', {
      eventBus: eventbus,
      ruleName: 'All-Eventbus-events-to-kinesis',
      eventPattern: {
        account: [cdk.Aws.ACCOUNT_ID]
      },
      targets: [
        kinesisTarget,
        snsTopicTarget
      ]
    });

    var insightsLayerArn = "arn:aws:lambda:" + process.env.CDK_DEFAULT_REGION + ":580247275435:layer:LambdaInsightsExtension:2";
    var insightsLayer = lambda.LayerVersion.fromLayerVersionArn(this, `LambdaInsights`, insightsLayerArn);
    const httpLogExtension = new HTTPLogsExtension(this, 'logsExtension')

    const pydepsLayer = new lambda.LayerVersion(this, 'UpgradeBoto3', {
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda-layer'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_7.bundlingDockerImage,
          command: [
            'bash', '-c', `
            pip install -r requirements.txt -t /asset-output/python &&
            cp -au . /asset-output/python/
            `,
          ],
        }
      }),
    });

    const py37DefaultBoto = new lambda.Function(this, 'py37DefaultBoto', {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda-handler')),
      tracing: lambda.Tracing.ACTIVE,
      layers: [insightsLayer],
      memorySize: 512,
      timeout: cdk.Duration.seconds(5)
    });

    const py37PackagedBoto = new lambda.Function(this, 'py37PackagedBoto', {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda-handler')),
      layers: [pydepsLayer, insightsLayer, httpLogExtension.extension],
      tracing: lambda.Tracing.ACTIVE,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(5)
    });

    const py37ProvisionedConcurrencyBoto = new lambda.Function(this, 'py37ProvisionedBoto', {
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda-handler')),
      tracing: lambda.Tracing.ACTIVE,
      layers: [insightsLayer],
      timeout: cdk.Duration.seconds(5)
    });

    new lambda.Alias(this, 'ProvisionedHandlerAlias', {
      aliasName: 'ProvisionedHandler',
      version: py37ProvisionedConcurrencyBoto.currentVersion,
      provisionedConcurrentExecutions: 2
    });

    const helloProvisionedIntegration = new apigwint.LambdaProxyIntegration({
      handler: py37ProvisionedConcurrencyBoto
    })

    const botoDefaultIntegration = new apigwint.LambdaProxyIntegration({
      handler: py37DefaultBoto
    })

    const botoPackagedIntegration = new apigwint.LambdaProxyIntegration({
      handler: py37PackagedBoto
    })

    httpApi.addRoutes({
      path: '/hello-pc',
      methods: [apigw.HttpMethod.GET],
      integration: helloProvisionedIntegration
    });

    httpApi.addRoutes({
      path: '/hello-boto',
      methods: [apigw.HttpMethod.GET],
      integration: botoDefaultIntegration
    });

    httpApi.addRoutes({
      path: '/hello-boto-packaged',
      methods: [apigw.HttpMethod.GET],
      integration: botoPackagedIntegration
    });

    const defaultResource = restApi.root.addResource('hello-boto');
    const defaultIntegration = new apigwv1.LambdaIntegration(py37DefaultBoto);
    defaultResource.addMethod('GET', defaultIntegration, {apiKeyRequired: false})

    const pcResource = restApi.root.addResource('hello-pc');
    const pcIntegration = new apigwv1.LambdaIntegration(py37ProvisionedConcurrencyBoto);
    pcResource.addMethod('GET', pcIntegration, {apiKeyRequired: false})

    const packagedResource = restApi.root.addResource('hello-boto-packaged');
    const packagedIntegration = new apigwv1.LambdaIntegration(py37PackagedBoto);
    packagedResource.addMethod('GET', packagedIntegration, {apiKeyRequired: false})
  }

  createHttpApi(): apigw.HttpApi {
    const httpApi = new apigw.HttpApi(this, 'sample-api', {
      corsPreflight: {
        allowHeaders: ['*'],
        allowOrigins: ['*'],
        allowMethods: [apigw.HttpMethod.GET],
      }
    });

    return httpApi;
  }

  createRestApi(): apigwv1.RestApi {
    let gateway = new apigwv1.RestApi(this, 'sample-rest-api', {
      deployOptions: {
        metricsEnabled: true,
        loggingLevel: apigwv1.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        tracingEnabled: true,
        stageName: 'prod'
      }
    });
    return gateway;
  }
}
export class HTTPLogsExtension extends cdk.Construct {
  readonly extension: lambda.ILayerVersion;
  constructor(scope: cdk.Construct, id: string) {
    super(scope, id);
    this.extension = new lambda.LayerVersion(scope, `${id}LayerVersion`, {
      code: lambda.Code.fromAsset(path.join(__dirname,
        'lambda-logs-extension/extension')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
    });
  }
}
