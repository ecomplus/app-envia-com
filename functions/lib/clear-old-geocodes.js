const { firestore } = require('firebase-admin')

module.exports = (context) => {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return firestore()
    .collection('geocodes')
    .where('at', '<', d.getTime())
    .limit(2000)
    .get().then(async querySnapshot => {
      for (const doc of querySnapshot.docs) {
        // eslint-disable-next-line no-await-in-loop
        await doc.ref.delete()
      }
      return querySnapshot
    })
}
