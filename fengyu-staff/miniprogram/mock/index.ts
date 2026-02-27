// mock/index.ts — Mock handler 注册表
import { authHandlers } from './auth'
import { workbenchHandlers } from './workbench'
import { customerHandlers } from './customer'
import { serviceHandlers } from './service'
import { appointmentHandlers } from './appointment'
import { orderHandlers } from './order'
import { productHandlers } from './product'
import { storeHandlers } from './store'
import { allocationHandlers } from './allocation'

export const mockHandlers: Record<string, (payload: Record<string, any>) => any> = {
  ...authHandlers,
  ...workbenchHandlers,
  ...customerHandlers,
  ...serviceHandlers,
  ...appointmentHandlers,
  ...orderHandlers,
  ...productHandlers,
  ...storeHandlers,
  ...allocationHandlers,
}
