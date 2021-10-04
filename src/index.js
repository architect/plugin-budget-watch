let { LambdaClient, PutFunctionConcurrencyCommand, GetFunctionConcurrencyCommand  } = require('@aws-sdk/client-lambda')
let { ResourceGroupsTaggingAPIClient, GetResourcesCommand } = require('@aws-sdk/client-resource-groups-tagging-api')
let { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm')

let stackName = process.env.ARC_CLOUDFORMATION
let triggerLambda = process.env.TRIGGER_LAMBDA
let resetLambda = process.env.RESET_LAMBDA
let region = process.env.AWS_REGION
let triggerSsm = process.env.TRIGGER_SSM


exports.handler =  async function handler (event) {
  console.log(event)

  if (event.Records.Sns){
    console.log(event.Records.Sns)
    let resourceClient = new ResourceGroupsTaggingAPIClient({ region })
    let allLambdas = []
    let targetLambdas
    let resourceInput = {
      ResourceTypeFilters: [ 'lambda' ],
      ResourcesPerPage: 100,
      TagFilters: [ { Key: 'aws:cloudformation:stack-name', Values: [ stackName ] } ]
    }
    let hasNext = true
    while (hasNext) {
      let resourceCommand = new GetResourcesCommand(resourceInput)
      let resourceResponse = await resourceClient.send(resourceCommand)
      let PaginationToken = resourceResponse.PaginationToken
      allLambdas.push(resourceResponse.ResourceTagMappingList)
      hasNext = PaginationToken
      if (hasNext) resourceInput = { ...resourceInput, PaginationToken }
    }

    targetLambdas = allLambdas.map(group => group.map(item => item.ResourceARN))
      .flat()
      .filter(lambda => !lambda.includes(triggerLambda) && !lambda.includes(resetLambda))
    console.log({ targetLambdas })

    let lambdaClient = new LambdaClient({ region })
    let concurrencyResponses = await Promise.all(targetLambdas.map(lambda => {
      let getLambdaCommand = new GetFunctionConcurrencyCommand({ FunctionName: lambda })
      return  lambdaClient.send(getLambdaCommand)
    }))
    let concurrencies = concurrencyResponses.map(response => response.ReservedConcurrentExecutions)
    let concurrencyPairs = targetLambdas.map((name, i) => ([ name, concurrencies[i] ]))
    console.log({ concurrencyPairs })

    let ssmClient = new SSMClient({ region })
    let ssmParams = {
      Name: triggerSsm,
      Type: 'String',
      Overwrite: true,
      Value: JSON.stringify(concurrencyPairs),
      Tag: { Key: 'aws:cloudformation:stack-name', Value: stackName }
    }
    let ssmCommand = new PutParameterCommand(ssmParams)
    await ssmClient.send(ssmCommand)

    let putLambdaCommands = await Promise.all(targetLambdas.map(lambda => {
      let lambdaCommand = new PutFunctionConcurrencyCommand({ FunctionName: lambda,
        ReservedConcurrentExecutions: 0 })
      return  lambdaClient.send(lambdaCommand).catch(e => console.log(e))
    }))
    console.log({ putLambdaCommands })

  }
  return
}

