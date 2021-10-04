[<img src="https://s3-us-west-2.amazonaws.com/arc.codes/architect-logo-500b@2x.png" width=500>](https://www.npmjs.com/package/@architect/plugin-budget-watch)

## [`@architect/plugin-budget-watch`](https://www.npmjs.com/package/@architect/plugin-budget-watch)

[![GitHub CI status](https://github.com/architect/plugin-budget-watch/workflows/Node%20CI/badge.svg)](https://github.com/architect/plugin-budget-watch/actions?query=workflow%3A%22Node+CI%22)

There are many ways a serverless app could run up your bill. Maybe you hit the top of hacker news, or you might have an infinite loop. The simplest way to stop a runaway app is to shut down the compute resources. By setting reserved concurrency (how many simultaneous executions can run) on all lambdas to zero, you can effectively stop the app. The budget-watch plugin can be added to an Architect app to accomplish this. 

### Install

`npm i @architect/plugin-budget-watch`

Add these lines to your Architect project manifest:

```arc
# app.arc
@plugins
architect/plugin-budget-watch
    
@budget
limit $40
email "notify@example.com"
```

Once deployed, there is a budget alert scoped to just the resources of the app. If the cost of those resources exceeds the limit set, a shutdown is triggered. To restart the app, the budget limit can be increased or removed and the app redeployed. This resets the lambda concurrencies, and the app will resume operation. 



