module.exports = async function () {
  if (global.__miniProgram) {
    await global.__miniProgram.close()
  }
}
