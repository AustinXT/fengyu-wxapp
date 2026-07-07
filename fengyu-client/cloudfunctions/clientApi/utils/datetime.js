


function shanghaiDateStr(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}


function shanghaiYMD(date = new Date()) {
  return shanghaiDateStr(date).replace(/-/g, '')
}


function shanghaiYYMMDD(date = new Date()) {
  return shanghaiDateStr(date).slice(2).replace(/-/g, '')
}

module.exports = { shanghaiDateStr, shanghaiYMD, shanghaiYYMMDD }
