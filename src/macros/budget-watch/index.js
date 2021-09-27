let { toLogicalID } = require('@architect/utils')
let path = require('path')

module.exports = function costDetection (arc, cfn) {

  let guard = arc['budget']

  if (guard) {

    let name = toLogicalID('budget-watch')
    let triggerSrc = path.resolve(__dirname, './src')
    let defaultBudget = 100
    let triggerAmount = guard && guard[0][0] === 'limit' ? Number(guard[0][1].replace('$', '')) : defaultBudget
    let triggerLambda = `${name}TriggerLambda`
    let triggerEvent = `${name}TriggerEvent`
    let triggerTopic = `${name}TriggerTopic`
    let triggerPolicy = `${name}TriggerTopicPolicy`
    let budget = `${name}StackBudget`
    let resetLambda = `${name}ResetLambda`
    let resetCustomResource = `${name}ResetCustomResource`
    let resetRole = `${name}ResetLambdaRole`
    let triggerSsm =  { 'Fn::Join': [ '', [ '/', { Ref: 'AWS::StackName' }, '/', 'ThrottledFunctions' ] ] }


    // Create the Trigger Lambda
    cfn.Resources[triggerLambda] = {
      Type: 'AWS::Serverless::Function',
      Properties: {
        Handler: 'index.handler',
        CodeUri: triggerSrc,
        Runtime: 'nodejs14.x',
        MemorySize: 512,
        Timeout: 30,
        Environment: { Variables: {
          ARC_CLOUDFORMATION: { Ref: 'AWS::StackName' },
          TRIGGER_LAMBDA: triggerLambda,
          RESET_LAMBDA: resetLambda,
          TRIGGER_SSM: triggerSsm,
        } },
        ReservedConcurrentExecutions: 1,
        Policies: [
          { Statement: [
            { Effect: 'Allow',
              Action: [
                'lambda:PutFunctionConcurrency',
                'lambda:GetFunctionConcurrency',
                'tag:*',
                'ssm:PutParameter',
                'ssm:AddTagsToResource',
              ],
              Resource: '*'
            }
          ]
          }
        ],
        Events: {
          [triggerEvent]: {
            Type: 'SNS',
            Properties: {
              Topic: { Ref: triggerTopic }
            }
          }
        }
      }
    }

    // Create the Trigger SNS topic
    cfn.Resources[triggerTopic] = {
      Type: 'AWS::SNS::Topic',
      Properties: {
        DisplayName: name,
        Subscription: []
      }
    }

    cfn.Resources[triggerPolicy] = {
      Type: 'AWS::SNS::TopicPolicy',
      Properties: {
        PolicyDocument: {
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'budgets.amazonaws.com'
              },
              Action: 'sns:Publish',
              Resource: {
                Ref: triggerTopic
              }
            }
          ]
        },
        Topics: [
          {
            Ref: triggerTopic
          }
        ]
      }
    }

    // Create the Budget to trigger on
    cfn.Resources[budget] = {
      Type: 'AWS::Budgets::Budget',
      Properties: {
        Budget: {
          BudgetLimit: {
            Amount: triggerAmount,
            Unit: 'USD'
          },
          TimeUnit: 'MONTHLY',
          BudgetType: 'COST',
          CostFilters: {
            // the format for value is <TagKey>$<TagValue> first $ is literal, second is replaced
            TagKeyValue: [ { 'Fn::Sub': 'aws:cloudformation:stack-name$${AWS::StackName}' } ]
          }
        },
        NotificationsWithSubscribers: [
          {
            Subscribers: [
              {
                SubscriptionType: 'SNS',
                Address: {
                  Ref: triggerTopic
                }
              }
            ],
            Notification: {
              ComparisonOperator: 'GREATER_THAN',
              NotificationType: 'ACTUAL',
              Threshold: 100,
              ThresholdType: 'PERCENTAGE'
            }
          }
        ]
      }
    }

    // Make all lambdas dependant on the reset custom resource
    // The SAM function resource does not expose the DependsOn property
    // Use a tag with GetAtt to make all functions dependant
    let lambdas = Object.keys(cfn.Resources).filter( name => cfn.Resources[name].Type === 'AWS::Serverless::Function')
    lambdas.forEach(resource => { cfn.Resources[resource].Properties.Tags = { 'CustomDependsOn': { 'Fn::GetAtt': [ resetCustomResource, 'DependsOn' ] } } }  )


    // TODO: create the SSM parameter in CFN as a placeholder so that it will be cleaned up if the stack is deleted

    // TODO: Get lambda concurrencies from CFN instead of getting them from the trigger api call. This will fix the edge 
    // case where concurrency is changed after limit is triggered, but before it is reset. Currently the reset will undo the 
    // intermediate update.

    cfn.Resources[resetRole] = {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: [
            { Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole' } ] },
        Path: '/',
        Policies: [
          { PolicyName: 'ResetPolicy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [ {
                Effect: 'Allow',
                Action: [
                  'lambda:PutFunctionConcurrency',
                  'lambda:DeleteFunctionConcurrency',
                  'ssm:GetParameter',
                  'ssm:DeleteParameter' ],
                Resource: '*' },
              { Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents' ],
                Resource: 'arn:aws:logs:*:*:*' } ]
            } } ]
      } }

    cfn.Resources[resetCustomResource] = {
      Type: 'AWS::CloudFormation::CustomResource',
      Properties: {
        ServiceToken: { 'Fn::GetAtt': `${resetLambda}.Arn` },
        // this value changes if the budget is changed
        // which triggers an update to the custom resource to reset concurrencies
        TriggerAmount: triggerAmount
      }
    }


    // This lambda is resets the concurrency of lambdas if the budget is updated
    // The code must be inlined with ZipFile to use the cfn-response module.
    // * Warning: If this lambda does not respond for any reason the stack deploy will
    // be hang for up to an hour until the operation times out.
    cfn.Resources[resetLambda] = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Handler: 'index.handler',
        Timeout: 30,
        Role: { 'Fn::GetAtt': `${resetRole}.Arn` },
        Runtime: 'nodejs14.x',
        ReservedConcurrentExecutions: 1,
        Environment: { Variables: {
          ARC_CLOUDFORMATION: { Ref: 'AWS::StackName' },
          TRIGGER_SSM: triggerSsm,
          TRIGGER_LAMBDA: triggerLambda,
          RESET_LAMBDA: resetLambda } },
        Code: {
          ZipFile: `
          let cfnresponse = require('cfn-response')
          let AWS = require('aws-sdk')
          let region = process.env.AWS_REGION
          let stackName = process.env.ARC_CLOUDFORMATION
          let ssm = new AWS.SSM({ region })
          let lambda = new AWS.Lambda({ region })
          let triggerSsm = process.env.TRIGGER_SSM

          exports.handler = function (event, context){
            console.log(event)

            if (event['RequestType'] === 'Delete' || event['RequestType'] === 'Update' ) {
              resetLambdas()
            } else if (event['RequestType'] === 'Create' ) {
              sendSuccess()
            } else {
              sendSuccess()
            }
 

            function sendSuccess(){
              let responseData = {DependsOn:'ready'}
              cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
            }

            async function resetLambdas(){
              try {
                let ssmResponse = await ssm.getParameter({ Name: triggerSsm }).promise().catch(e=>{
                  console.log(e)
                  sendSuccess()
                })
                console.log({ssmResponse})
                if (ssmResponse?.Parameter?.Value){
                  let throttled = JSON.parse(ssmResponse.Parameter.Value)
                  let concurrencyResponses = await Promise.all(throttled.map(tuple => { 
                    if (tuple[1] === null || tuple[1] === undefined){
                      return lambda.deleteFunctionConcurrency({ FunctionName:tuple[0], ReservedConcurrentExecutions:tuple[1] })
                        .promise().catch( e => console.log(e) )
                    } else { 
                      return lambda.putFunctionConcurrency({ FunctionName:tuple[0], ReservedConcurrentExecutions:tuple[1] })
                        .promise().catch( e => console.log(e) )
                    }
                  }))
                  console.log({concurrencyResponses})
                  await ssm.deleteParameter({ Name: triggerSsm }).promise()
                }
                sendSuccess()
              } catch(e) {
                console.log(e)
                cfnresponse.send(event, context, cfnresponse.FAILED, {})
              }
            }
          }`
        }
      }
    }
  }

  return cfn

}

