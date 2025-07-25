const axios = require('axios')
const { debugAxiosError } = require('./util')

/**
 * Envia.com API helper for shipping label creation
 */
class EnviaAPI {
  constructor (apiKey, storeId, sandbox = false) {
    this.apiKey = apiKey
    this.storeId = storeId
    this.baseUrl = sandbox ? 'https://ship-test.envia.com' : 'https://api.envia.com'
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  }

  /**
   * Create shipping label for an order
   * @param {Object} order - E-Com Plus order object
   * @returns {Promise<Object>} Envia.com shipment response
   */
  async createShippingLabel (order) {
    try {
      // Extract shipping and billing info from order
      const shippingLine = order.shipping_lines && order.shipping_lines[0]
      if (!shippingLine) {
        throw new Error('No shipping line found in order')
      }

      const shippingAddress = shippingLine.to
      if (!shippingAddress || !shippingAddress.zip) {
        throw new Error('Missing shipping address information')
      }

      // Calculate total weight and dimensions
      let totalWeight = 0
      const items = []

      if (order.items && order.items.length > 0) {
        order.items.forEach(item => {
          const weight = item.weight ? item.weight.value || 0.1 : 0.1
          totalWeight += item.quantity * weight
          items.push({
            name: item.name || 'Item',
            description: item.variation_id ? `${item.name} - ${item.variation_id}` : item.name,
            weight,
            value: item.price || 0,
            quantity: item.quantity || 1,
            sku: item.sku || item.product_id
          })
        })
      }

      // Default package dimensions
      const packageData = {
        weight: totalWeight || 0.1,
        length: 20,
        width: 20,
        height: 5,
        declaredValue: order.amount ? order.amount.total : 0
      }

      // Prepare Envia.com shipment request
      const shipmentRequest = {
        origin: {
          name: 'Loja',
          postalCode: shippingLine.from && shippingLine.from.zip
            ? shippingLine.from.zip.replace(/\D/g, '')
            : '',
          country: 'BR'
        },
        destination: {
          name: `${shippingAddress.name || ''} ${shippingAddress.surname || ''}`.trim(),
          company: shippingAddress.corporate_name || '',
          address1: shippingAddress.street || '',
          address2: shippingAddress.complement || '',
          city: shippingAddress.city || '',
          state: shippingAddress.province_code || '',
          postalCode: shippingAddress.zip.replace(/\D/g, ''),
          country: 'BR',
          phone: shippingAddress.phone ? shippingAddress.phone.number : '',
          email: order.buyers && order.buyers[0] ? order.buyers[0].main_email : ''
        },
        packages: [{
          weight: packageData.weight,
          length: packageData.length,
          width: packageData.width,
          height: packageData.height,
          declaredValue: packageData.declaredValue
        }],
        service: shippingLine.service_code || 'standard',
        reference: order.number ? order.number.toString() : order._id,
        items
      }

      // Create shipment using generic POST method
      const response = await this.fetch('/v1/ship/shipments', shipmentRequest, 30000)

      console.log(`Envia.com shipment created for order ${order._id}:`, response.id)
      return response
    } catch (error) {
      console.error('Error creating Envia.com shipment:', error.response?.data || error.message)
      throw error
    }
  }

  /**
   * Generic request method for Envia.com API calls
   * @param {string} endpoint - API endpoint (e.g., '/v1/ship/rates', '/v1/ship/shipments')
   * @param {Object} data - Request payload data
   * @param {number} timeout - Request timeout in milliseconds (default: 10000)
   * @returns {Promise<Object>} API response data
   */
  async fetch (endpoint, data, timeout = 10000) {
    try {
      const response = await axios({
        baseURL: this.baseUrl,
        url: endpoint,
        method: data ? 'post' : 'get',
        headers: this.headers,
        data,
        timeout
      })
      return response.data
    } catch (error) {
      debugAxiosError(error, this.storeId)
      throw error
    }
  }

  /**
   * Get tracking information for a shipment
   * @param {string} shipmentId - Envia.com shipment ID
   * @returns {Promise<Object>} Tracking information
   */
  async getTracking (shipmentId) {
    try {
      const response = await axios.get(`${this.baseUrl}/v1/ship/shipments/${shipmentId}/tracking`, {
        headers: this.headers,
        timeout: 10000
      })

      return response.data
    } catch (error) {
      debugAxiosError(error)
      throw error
    }
  }
}

module.exports = EnviaAPI
