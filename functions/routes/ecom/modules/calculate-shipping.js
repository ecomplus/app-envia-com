const axios = require('axios')
const { logger } = require('firebase-functions')
const EnviaAPI = require('../../../lib/envia-api')
const { getBestPackage } = require('../../../lib/util')

const commonCarriers = [
  {
    name: 'correios',
    description: 'Correios',
    country_code: 'BR'
  },
  {
    name: 'ups',
    description: 'UPS',
    country_code: 'BR'
  },
  {
    name: 'shippify',
    description: 'Shippify',
    country_code: 'BR'
  },
  {
    name: 'Jadlog',
    description: 'Jadlog',
    country_code: 'BR'
  },
  {
    name: 'dhl',
    description: 'DHL Express',
    country_code: 'BR'
  },
  {
    name: 'buslog',
    description: 'Buslog',
    country_code: 'BR'
  },
  {
    name: 'totalExpress',
    description: 'Total Express',
    country_code: 'BR'
  },
  {
    name: 'loggi',
    description: 'Loggi',
    country_code: 'BR'
  }
]

exports.post = async ({ appSdk, admin }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-datafrete/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  if (!appData.api_key) {
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: 'Key app hidden data (merchant must configure the app)'
    })
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
  const checkZipCode = rule => {
    if (destinationZip && rule.zip_range) {
      const { min, max } = rule.zip_range
      return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
    }
    return true
  }

  let originZip = params.from?.zip || appData.zip
  const postingDeadline = appData.posting_deadline
  originZip = typeof originZip === 'string' ? originZip.replace(/\D/g, '') : ''

  // search for configured free shipping rule
  if (Array.isArray(appData.shipping_rules)) {
    for (let i = 0; i < appData.shipping_rules.length; i++) {
      const rule = appData.shipping_rules[i]
      if (rule.free_shipping && checkZipCode(rule)) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    return res.send(response)
  }

  if (!originZip) {
    // must have configured origin zip code to continue
    return res.status(409).send({
      error: 'CALCULATE_ERR',
      message: 'Zip code is unset on app hidden data (merchant must configure the app)'
    })
  }

  if (!params.items?.length) {
    return res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  // optional params to Correios services
  let secureValue = 0
  if (params.subtotal) {
    secureValue = params.subtotal
  }

  // calculate weight and pkg value from items list
  let pkgCm3Vol = 0
  let pkgKgWeight = 0
  params.items.forEach(({ price, quantity, dimensions, weight }) => {
    let physicalWeight = 0
    let cubicWeight = 0
    if (!params.subtotal) {
      secureValue += price * quantity
    }

    // sum physical weight
    if (weight && weight.value) {
      switch (weight.unit) {
        case 'kg':
          physicalWeight = weight.value
          break
        case 'g':
          physicalWeight = weight.value / 1000
          break
        case 'mg':
          physicalWeight = weight.value / 1000000
      }
    }

    // sum total items dimensions to calculate cubic weight
    if (dimensions) {
      const cmDimensions = {}
      for (const side in dimensions) {
        const dimension = dimensions[side]
        if (dimension?.value) {
          switch (dimension.unit) {
            case 'm':
              cmDimensions[side] = dimension.value * 100
              break
            case 'mm':
              cmDimensions[side] = dimension.value / 10
              break
            default:
              cmDimensions[side] = dimension.value
          }
        }
      }
      let cm3 = 1
      for (const side in cmDimensions) {
        if (cmDimensions[side]) {
          cm3 *= cmDimensions[side]
        }
      }
      // https://ajuda.melhorenvio.com.br/pt-BR/articles/4640361-como-e-calculado-o-peso-cubico-pelos-correios
      // (C x L x A) / 6.000
      if (cm3 > 1) {
        cubicWeight = cm3 / 6000
        pkgCm3Vol += (quantity * cm3)
      }
    }
    pkgKgWeight += (quantity * (physicalWeight > cubicWeight ? physicalWeight : cubicWeight))
  })

  const enviaPackage = {
    content: (params.items.length === 1 && params.items[0].name) || 'Pedido',
    amount: 1,
    type: 'box',
    weight: pkgKgWeight || 0.1,
    weightUnit: 'KG',
    dimensions: {
      height: 36,
      width: 70,
      length: 36,
      ...getBestPackage(pkgCm3Vol)
    },
    lengthUnit: 'CM',
    declaredValue: secureValue
  }
  const enviaQuote = {
    origin: {
      postalCode: originZip,
      country: 'BR'
    },
    destination: {
      postalCode: destinationZip,
      country: 'BR'
    },
    packages: [enviaPackage],
    shipment: {
      type: 1
    },
    settings: {
      currency: 'BRL'
    }
  }

  const fieldsToGeocodes = ['origin', 'destination']
  for (let i = 0; i < fieldsToGeocodes.length; i++) {
    const quoteAddr = enviaQuote[fieldsToGeocodes[i]]
    const { postalCode } = quoteAddr
    let geocodes
    try {
      const docRef = admin.firestore().doc(`geocodes/${postalCode}`)
      const docSnap = await docRef.get()
      if (docSnap.exists) {
        geocodes = docSnap.data().geocodes
      } else {
        const { data } = await axios.get(`https://geocodes.envia.com/zipcode/BR/${postalCode}`)
        geocodes = data[0]
        await docRef.set({
          geocodes,
          at: Date.now()
        })
      }
    } catch (err) {
      logger.warn(err)
    }
    if (geocodes) {
      quoteAddr.state = geocodes.state?.code?.['2digit']
      quoteAddr.city = geocodes.locality
    }
  }

  const enviaCarriers = []
  if (!appData.carriers?.length) {
    enviaCarriers.push('correios')
  } else {
    appData.carriers.forEach((carrierName) => {
      const commonCarrier = commonCarriers.find(({ name, description }) => {
        return name === carrierName || description === carrierName
      })
      enviaCarriers.push(commonCarrier?.name || carrierName)
    })
  }

  await Promise.all(enviaCarriers.map(async (carrier) => {
    const enviaFinalQuote = {
      ...enviaQuote,
      shipment: {
        ...enviaQuote.shipment,
        carrier
      }
    }

    try {
      const enviaApi = new EnviaAPI(appData.api_key, storeId, appData.sandbox)
      const enviaResponse = await enviaApi.fetch('/ship/rate/', enviaFinalQuote)

      if (enviaResponse?.data) {
        enviaResponse.data.forEach(rate => {
          const deliveryDays = parseInt(rate?.deliveryDate?.dateDifference)
          if (!deliveryDays) return
          const price = parseFloat(rate.totalPrice)
          if (!price) return

          const matchService = (serviceName) => {
            return serviceName && (
              serviceName === rate.serviceDescription ||
              serviceName === rate.service ||
              serviceName === rate.carrierDescription ||
              serviceName === rate.carrier
            )
          }
          if (Array.isArray(appData.disable_services)) {
            const shouldDisable = appData.disable_services.some(rule => {
              if (!rule.service_name) return false
              if (matchService(rule.service_name)) return checkZipCode(rule)
              return true
            })
            if (shouldDisable) return
          }

          const serviceName = rate.serviceDescription || rate.service
          let label = serviceName || 'Envia.com'
          if (serviceName && Array.isArray(appData.service_labels)) {
            const serviceOpts = appData.service_labels.find((rule) => {
              return matchService(rule?.service_name)
            })
            if (serviceOpts?.label) {
              label = serviceOpts.label
            }
          }

          const shippingLine = {
            from: {
              ...params.from,
              zip: originZip
            },
            to: params.to,
            price,
            total_price: price,
            declared_value: secureValue,
            discount: 0,
            delivery_time: {
              days: deliveryDays,
              working_days: true
            },
            posting_deadline: {
              days: 3,
              ...postingDeadline
            },
            package: {
              package: {
                weight: {
                  value: enviaPackage.weight,
                  unit: 'kg'
                },
                dimensions: {
                  width: {
                    value: enviaPackage.dimensions.width,
                    unit: 'cm'
                  },
                  height: {
                    value: enviaPackage.dimensions.height,
                    unit: 'cm'
                  },
                  length: {
                    value: enviaPackage.dimensions.length,
                    unit: 'cm'
                  }
                }
              }
            },
            flags: ['enviacom-rate']
          }

          // search for discount by shipping rule
          if (Array.isArray(appData.shipping_rules)) {
            for (let i = 0; i < appData.shipping_rules.length; i++) {
              const rule = appData.shipping_rules[i]
              if (
                rule &&
                (!rule.service || matchService(rule.service)) &&
                checkZipCode(rule) &&
                !(rule.min_amount > secureValue)
              ) {
                // valid shipping rule
                if (rule.free_shipping) {
                  shippingLine.discount += shippingLine.total_price
                  shippingLine.total_price = 0
                  break
                } else if (rule.discount) {
                  let discountValue = rule.discount.value
                  if (rule.discount.percentage) {
                    discountValue *= (shippingLine.total_price / 100)
                  }
                  if (discountValue) {
                    shippingLine.discount += discountValue
                    shippingLine.total_price -= discountValue
                    if (shippingLine.total_price < 0) {
                      shippingLine.total_price = 0
                    }
                  }
                  break
                }
              }
            }
          }

          response.shipping_services.push({
            label,
            carrier: rate.carrierDescription || rate.carrier,
            service_name: serviceName?.substring(0, 70),
            service_code: (rate.service || rate.serviceId)?.substring(0, 70),
            shipping_line: shippingLine
          })
        })
      } else {
        logger.warn(`#${storeId} unexpected Envia.com response`, {
          destinationZip,
          enviaFinalQuote,
          enviaResponse
        })
      }

      if (appData.delivery_instructions) {
        response.shipping_services.forEach(service => {
          service.delivery_instructions = appData.delivery_instructions
        })
      }
    } catch (error) {
      logger.error(`#${storeId} error calling Envia.com API: ${error.message}`)
    }
  }))

  res.send(response)
}
