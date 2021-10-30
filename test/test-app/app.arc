
@app
budget-test

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


@budget
limit $100

@aws
region us-east-1
profile plugin-test-profile
