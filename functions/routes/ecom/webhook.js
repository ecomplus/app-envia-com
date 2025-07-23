// read configured E-Com Plus app data
const getAppData = require('./../../lib/store-api/get-app-data')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body

  // get app configured options
  getAppData({ appSdk, storeId })

    .then(appData => {
      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      /* Handle shipping tag creation based on order status */
      if (trigger.resource === 'orders' && trigger.body) {
        const order = trigger.body

        // Check if auto-tagging is enabled
        if (!appData.disable_auto_tag && appData.api_key) {
          const parseStatus = (status) => {
            switch (status && status.current) {
              case 'paid': return 'Pago'
              case 'in_production': return 'Em produção'
              case 'in_separation': return 'Em separação'
              case 'ready_for_shipping': return 'Pronto para envio'
              case 'invoice_issued': return 'NF emitida'
              case 'shipped': return 'Enviado'
              default: return status && status.current
            }
          }

          const targetStatus = appData.send_tag_status || 'Pronto para envio'
          const currentFinancialStatus = parseStatus(order.financial_status)
          const currentFulfillmentStatus = parseStatus(order.fulfillment_status)

          // Check if either financial_status or fulfillment_status matches target status
          if (currentFinancialStatus === targetStatus || currentFulfillmentStatus === targetStatus) {
            console.log(`Creating Envia.com shipping tag for order ${order._id} with status ${targetStatus}`)

            // Create shipping label asynchronously
            const EnviaAPI = require('./../../lib/envia-api')
            const enviaApi = new EnviaAPI(appData.api_key, appData.sandbox)

            enviaApi.createShippingLabel(order)
              .then(shipment => {
                if (shipment && shipment.id) {
                  console.log(`Envia.com shipment ${shipment.id} created for order ${order._id}`)
                  // Optionally update order with tracking info
                  if (shipment.trackingNumber) {
                    // Update order shipping line with tracking number
                    // This could be implemented later if needed
                    console.log(`Tracking number: ${shipment.trackingNumber}`)
                  }
                }
              })
              .catch(error => {
                console.error(`Failed to create Envia.com shipment for order ${order._id}:`, error.message)
              })
          }
        }
      }

      // all done
      res.send(ECHO_SUCCESS)
    })

    .catch(err => {
      if (err.name === SKIP_TRIGGER_NAME) {
        // trigger ignored by app configuration
        res.send(ECHO_SKIP)
      } else if (err.appWithoutAuth === true) {
        const msg = `Webhook for ${storeId} unhandled with no authentication found`
        const error = new Error(msg)
        error.trigger = JSON.stringify(trigger)
        console.error(error)
        res.status(412).send(msg)
      } else {
        // console.error(err)
        // request to Store API with error response
        // return error status code
        res.status(500)
        const { message } = err
        res.send({
          error: ECHO_API_ERROR,
          message
        })
      }
    })
}
