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
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

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

  try {
    // Calculate total weight and dimensions
    let totalWeight = 0
    let totalValue = params.subtotal || 0
    const items = []

    if (params.items) {
      params.items.forEach(item => {
        const weight = item.weight ? item.weight.value || 0 : 0
        totalWeight += item.quantity * weight
        
        items.push({
          name: item.name || 'Item',
          weight: weight,
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

    // Call envia.com quote API
    const axios = require('axios')
    const enviaBaseUrl = appData.sandbox ? 'https://ship-test.envia.com' : 'https://ship.envia.com'
    
    const enviaResponse = await axios.post(`${enviaBaseUrl}/v1/ship/rates`, enviaRequest, {
      headers: {
        'Authorization': `Bearer ${appData.api_key}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    })

    // Transform envia.com response to E-com Plus format
    if (enviaResponse.data && enviaResponse.data.rates) {
      enviaResponse.data.rates.forEach(rate => {
        if (rate.totalPrice && rate.deliveryDays) {
          response.shipping_services.push({
            label: rate.serviceName || rate.carrierName || 'Envia.com',
            carrier: rate.carrierName || 'Envia.com',
            service_name: rate.serviceName,
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
          })
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
