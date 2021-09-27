
# Budget-watch Architect Macro
There are many ways an app could run up your bill. Maybe you hit the top of hacker news, or maybe you have an infinite loop. The simplest way to stop a runaway app in most cases is to shut down the compute resources. By setting reserved concurrency (how many simultaneous executions can run) on all lambdas to zero, you can effectively stop the app. The budget-watch macro can be added to an Architect app with the four lines shown below. 

```
@macros
budget-watch
    
@budget
limit $40
```

Once deployed, there is a budget alert scoped to just the resources of the app. If the cost of those resources exceeds the limit set, a shutdown is triggered. To restart the app, the budget limit can be increase or removed and the app redeployed. This resets the lambda concurrencies, and the app will resume operation. 
