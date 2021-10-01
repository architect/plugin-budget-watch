// learn more about event functions here: https://arc.codes/primitives/events
exports.handler = async function subscribe (event) {
  console.log(JSON.stringify(event, null, 2))
  return
}