/**
 * Register clarify_uncertainty tool.
 * Only active when high-confidence mode is enabled.
 */
import { registry } from './registry.js'
import { clarifyUncertaintyDescriptor } from './clarify_uncertainty.js'

registry.register({
  name: clarifyUncertaintyDescriptor.name,
  description: clarifyUncertaintyDescriptor.description,
  schema: clarifyUncertaintyDescriptor.schema,
  handler: clarifyUncertaintyDescriptor.handler,
})
