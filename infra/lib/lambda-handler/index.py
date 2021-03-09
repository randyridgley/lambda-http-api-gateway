import boto3
from random import randint
from time import sleep

def handler(event, context):
    sleep(randint(1,3))

    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'text/plain',
            'x-custom-header': 'My Header Value'
        },
        'body': 'This lambda is using boto version {}\n'.format(boto3.__version__)
    }