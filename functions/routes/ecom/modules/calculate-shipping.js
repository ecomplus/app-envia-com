exports.post = async ({ appSdk }, req, res) => {
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
  // const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  // Helper function to check ZIP code ranges
  const checkZipCode = (zipCode, zipRange) => {
    if (!zipRange) return true
    const zip = parseInt(zipCode.replace(/\D/g, ''))
    return zip >= zipRange.min && zip <= zipRange.max
  }

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }
  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  // Check if required credentials are available
  if (!appData.api_key) {
    console.error('Missing envia.com API key')
    res.send(response)
    return
  }

  // Validate required fields for BR sellers
  if (!params.from || !params.from.zip || !params.to.zip) {
    console.error('Missing zip codes for shipping calculation')
    res.send(response)
    return
  }

  let totalWeight = 0
  try {
    // Calculate total weight and dimensions
    const totalValue = params.subtotal || 0
    const items = []

    if (params.items) {
      params.items.forEach(item => {
        const weight = item.weight ? item.weight.value || 0 : 0
        totalWeight += item.quantity * weight
        items.push({
          name: item.name || 'Item',
          weight,
          value: item.price || 0,
          quantity: item.quantity || 1
        })
      })
    }

    // Default dimensions if not specified
    const packageDimensions = {
      length: appData.default_length || 20,
      width: appData.default_width || 20,
      height: appData.default_height || 5
    }

    // Prepare envia.com quote request
    const enviaRequest = {
      origin: {
        postalCode: params.from.zip.replace(/\D/g, ''),
        country: 'BR'
      },
      destination: {
        postalCode: params.to.zip.replace(/\D/g, ''),
        country: 'BR'
      },
      packages: [{
        weight: totalWeight || 0.1, // Minimum weight 0.1kg
        length: packageDimensions.length,
        width: packageDimensions.width,
        height: packageDimensions.height,
        declaredValue: totalValue
      }],
      services: appData.enabled_services || ['standard'],
      currency: 'BRL'
    }

    // Call envia.com quote API using wrapper
    const EnviaAPI = require('./../../lib/envia-api')
    const enviaApi = new EnviaAPI(appData.api_key, appData.sandbox)

    const enviaResponse = await enviaApi.post('/v1/ship/rates', enviaRequest)

    // Transform envia.com response to E-com Plus format
    if (enviaResponse && enviaResponse.rates) {
      enviaResponse.rates.forEach(rate => {
        if (rate.totalPrice && rate.deliveryDays) {
          const serviceName = rate.serviceName || rate.serviceCode
          const destinationZip = params.to.zip

          // Check if service should be disabled
          if (appData.disable_services && Array.isArray(appData.disable_services)) {
            const shouldDisable = appData.disable_services.some(rule => {
              return rule.service_name === serviceName && checkZipCode(destinationZip, rule.zip_range)
            })
            if (shouldDisable) return
          }

          // Calculate posting deadline
          let postingDeadline
          if (appData.posting_deadline) {
            postingDeadline = {
              days: appData.posting_deadline.days || 3,
              working_days: appData.posting_deadline.working_days !== false,
              after_approval: appData.posting_deadline.after_approval !== false
            }
          }

          // Base shipping service object
          const shippingService = {
            label: rate.serviceName || rate.carrierName || 'Envia.com',
            carrier: rate.carrierName || 'Envia.com',
            service_name: serviceName,
            service_code: rate.serviceCode,
            shipping_line: {
              from: params.from,
              to: params.to,
              package: {
                weight: {
                  value: totalWeight,
                  unit: 'kg'
                },
                dimensions: packageDimensions
              },
              price: parseFloat(rate.totalPrice),
              delivery_time: {
                days: parseInt(rate.deliveryDays),
                working_days: rate.workingDays !== false
              }
            }
          }

          // Add posting deadline if configured
          if (postingDeadline) {
            shippingService.shipping_line.posting_deadline = postingDeadline
          }

          // Apply shipping rules
          if (appData.shipping_rules && Array.isArray(appData.shipping_rules)) {
            for (const rule of appData.shipping_rules) {
              // Check if rule applies
              const ruleApplies = (!rule.service || rule.service === serviceName) &&
                checkZipCode(destinationZip, rule.zip_range) &&
                (!rule.min_amount || totalValue >= rule.min_amount)

              if (ruleApplies) {
                // Apply free shipping
                if (rule.free_shipping) {
                  shippingService.shipping_line.price = 0
                  shippingService.shipping_line.free_shipping = true
                  break
                }

                // Apply discount
                if (rule.discount && rule.discount.value) {
                  let discount = rule.discount.value
                  if (rule.discount.percentage) {
                    discount = shippingService.shipping_line.price * (discount / 100)
                  }
                  shippingService.shipping_line.price = Math.max(0, shippingService.shipping_line.price - discount)
                  if (shippingService.shipping_line.price === 0) {
                    shippingService.shipping_line.free_shipping = true
                  }
                  break
                }
              }
            }
          }

          response.shipping_services.push(shippingService)
        }
      })
    }

    // Add delivery instructions if configured
    if (appData.delivery_instructions) {
      response.shipping_services.forEach(service => {
        service.delivery_instructions = appData.delivery_instructions
      })
    }
  } catch (error) {
    console.error('Error calling envia.com API:', error.message)

    // Add fallback shipping option if API fails
    if (appData.fallback_enabled) {
      response.shipping_services.push({
        label: appData.fallback_label || 'Entrega padrão',
        carrier: 'Envia.com',
        shipping_line: {
          from: params.from,
          to: params.to,
          package: {
            weight: {
              value: totalWeight || 0.1
            }
          },
          price: appData.fallback_price || 15,
          delivery_time: {
            days: appData.fallback_days || 7,
            working_days: true
          }
        }
      })
    }
  }

  res.send(response)
}
