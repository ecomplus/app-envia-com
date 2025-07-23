const { logger } = require('firebase-functions')

const pkgCms = [
  { height: 4, width: 16, length: 24 },
  { height: 4, width: 36, length: 28 },
  { height: 9, width: 27, length: 18 },
  { height: 9, width: 18, length: 13.5 },
  { height: 13.5, width: 27, length: 22.5 },
  { height: 18, width: 36, length: 27 },
  { height: 27, width: 36, length: 27 },
  { height: 27, width: 54, length: 36 },
  { height: 36, width: 70, length: 36 }
]
const getBestPackage = (pkgCm3Vol) => {
  let smallestPkg
  let smallestPkgCm3
  pkgCms.forEach((currentPkg) => {
    let currentPkgCm3 = 1
    Object.values(currentPkg).forEach((cm) => {
      currentPkgCm3 *= cm
    })
    if (currentPkgCm3 < pkgCm3Vol) return
    if (!smallestPkgCm3 || smallestPkgCm3 > currentPkgCm3) {
      smallestPkg = currentPkg
      smallestPkgCm3 = currentPkgCm3
    }
  })
  return smallestPkg
}

const debugAxiosError = (error, storeId) => {
  let msg = error.message
  if (storeId) {
    msg = `${msg} [#${storeId}]`
  }
  const err = new Error(msg)
  if (error.response) {
    err.status = error.response.status
    err.response = error.response.data
  }
  err.request = error.config
  logger.error(err)
}

module.exports = {
  getBestPackage,
  debugAxiosError
}
