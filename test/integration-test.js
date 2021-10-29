let test = require('tape')
let AWS = require('aws-sdk')
let { execSync } = require('child_process')
let path = require('path')
let crypto = require('crypto')
let inventory = require('@architect/inventory')
let utils = require('@architect/utils')
let fs = require('fs')

let appDir = path.resolve(__dirname, './test-app')

function manifest (budget){
  return  `
@app
integration-test

@http
get /

@events
likes

@queues
publish-log

@scheduled
daily-update-buddy rate(1 day)

@plugins
plugin-budget-watch

${budget}

`
}

test('Create Test App', t => {
  t.plan(1)
  let initialManifest = manifest(`
@budget
limit $1`)

  fs.writeFileSync(path.join(appDir, 'app.arc'), initialManifest)
  t.pass('Created Test App')
})



let appName
test('App Inventory', async t => {
  t.plan(1)
  let appInventory = await inventory({ cwd: appDir })
  appName = appInventory.get.app()
  t.ok(appName, 'App inventory verified')
})

let uniqueName, cfnName
test('Deploy App', t => {
  t.plan(1)
  uniqueName = 'A' + crypto.randomBytes(3).toString('hex')
  cfnName = utils.toLogicalID(appName) + 'Staging' + uniqueName
  execSync(`npx arc deploy --name "${uniqueName}"`, { cwd: appDir, timeout: 1000 * 60 * 60 * 5 } )
  t.pass('It deployed')
})


// let testProfile = 'plugin-test-profile'
let region = 'us-east-1'
// let credentials = new AWS.SharedIniFileCredentials({})
// AWS.config.credentials = credentials
AWS.config.update({ region })
let  resourcegroupstaggingapi = new AWS.ResourceGroupsTaggingAPI()
let lambdaArns
test('Find Stack Lambdas', async t => {
  t.plan(1)
  let resourceParams = {
    ResourceTypeFilters: [ 'lambda' ],
    ResourcesPerPage: 100,
    TagFilters: [ { Key: 'aws:cloudformation:stack-name', Values: [ cfnName ] } ],
  }
  let stackLambdas =  await resourcegroupstaggingapi.getResources(resourceParams).promise()
  lambdaArns = stackLambdas.ResourceTagMappingList.map(item => item.ResourceARN)
  t.ok(lambdaArns, 'Found the Lambdas')
})


let trigger, reset, targets
test('Find Trigger and Reset', async t => {
  t.plan(3)
  trigger = lambdaArns.find(arn => arn.includes('BudgetWatchTriggerLambda'))
  reset = lambdaArns.find(arn => arn.includes('BudgetWatchResetLambda'))
  targets = lambdaArns.filter(arn => arn !== reset && arn !== trigger)
  t.ok(trigger, 'trigger found')
  t.ok(reset, 'reset found')
  t.ok(targets.length !== 0, 'targets found')
})

let lambda = new AWS.Lambda()
let targetCon, triggerCon, resetCon
test('Find Initial Concurrencies', async t => {
  t.plan(3)
  targetCon = (await Promise.all(targets.map(arn => lambda.getFunctionConcurrency({ FunctionName: arn }).promise())))
    .map(resp => resp.ReservedConcurrentExecutions)
  triggerCon = (await lambda.getFunctionConcurrency({ FunctionName: trigger }).promise()).ReservedConcurrentExecutions
  resetCon = (await lambda.getFunctionConcurrency({ FunctionName: reset }).promise()).ReservedConcurrentExecutions
  let targetZeros = targetCon.filter(con => con === 0).length
  t.ok(targetZeros === 0, 'Target lambdas running')
  t.ok(triggerCon === 1, 'Trigger Concurreny 1')
  t.ok(resetCon === 1, 'Reset Concurreny 1')
})

test('Trigger Shutdown', async t => {
  t.plan(3)
  await lambda.invoke({ FunctionName: trigger, Payload: JSON.stringify( { Records: { Sns: 'Integration test' } }) }).promise()

  let offTargetCon = (await Promise.all(targets.map(arn => lambda.getFunctionConcurrency({ FunctionName: arn }).promise())))
    .map(resp => resp.ReservedConcurrentExecutions)
  let offTriggerCon = (await lambda.getFunctionConcurrency({ FunctionName: trigger }).promise()).ReservedConcurrentExecutions
  let offResetCon = (await lambda.getFunctionConcurrency({ FunctionName: reset }).promise()).ReservedConcurrentExecutions
  let targetNonZero = offTargetCon.filter(con => con !== 0).length
  t.ok(targetNonZero === 0, 'Target lambdas all shut off')
  t.ok(offTriggerCon === 1, 'Trigger Concurreny still 1')
  t.ok(offResetCon === 1, 'Reset Concurreny still 1')

})


test('Reset On Deploy', async t => {
  t.plan(4)
  let resetManifest = manifest( `
@budget
limit $100`)

  fs.writeFileSync(path.join(appDir, 'app.arc'), resetManifest)

  execSync(`npx arc deploy --name "${uniqueName}"`, { cwd: appDir, timeout: 1000 * 60 * 60 * 5 } )
  t.pass('It it reployed')
  let resetTargetCon = (await Promise.all(targets.map(arn => lambda.getFunctionConcurrency({ FunctionName: arn }).promise())))
    .map(resp => resp.ReservedConcurrentExecutions)
  let resetTriggerCon = (await lambda.getFunctionConcurrency({ FunctionName: trigger }).promise()).ReservedConcurrentExecutions
  let resetResetCon = (await lambda.getFunctionConcurrency({ FunctionName: reset }).promise()).ReservedConcurrentExecutions
  t.ok(triggerCon === resetTriggerCon, 'Trigger reset')
  t.ok(resetCon === resetResetCon, 'Reset reset')
  // let sortedTarget =[...targetCon].sort()
  // let sortedResetTarget =[...resetTargetCon].sort()
  t.deepEqual(resetTargetCon, resetTargetCon, 'All Lambdas Reset')


})



test('Teardown App', async t => {
  t.plan(1)
  execSync(`npx arc destroy --app "${appName}" --name "${uniqueName}" --force --now`, { cwd: appDir, timeout: 1000 * 60 * 60 * 5 } ).toString()
  t.pass( 'The app is gone')
  // t.ok(destroyOutput.includes(`Successfully destroyed ${cfnName}`), 'The app is gone')
})


