


function buildMonthlyData(yearMonth: string) {
  const [y, m] = yearMonth.split('-').map(Number)
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const daysInMonth = new Date(y, m, 0).getDate()

  
  const businessDays: Record<string, { amount: number; orderCount: number; serviceCount: number }> = {
    [`${yearMonth}-05`]: { amount: 3200, orderCount: 2, serviceCount: 3 },
    [`${yearMonth}-08`]: { amount: 5000, orderCount: 3, serviceCount: 4 },
    [`${yearMonth}-12`]: { amount: 2800, orderCount: 1, serviceCount: 2 },
    [`${yearMonth}-15`]: { amount: 4500, orderCount: 2, serviceCount: 3 },
    [`${yearMonth}-19`]: { amount: 6200, orderCount: 4, serviceCount: 5 },
    [`${yearMonth}-22`]: { amount: 3800, orderCount: 2, serviceCount: 3 },
    [`${yearMonth}-25`]: { amount: 1500, orderCount: 1, serviceCount: 1 },
  }

  const dailyData = []
  let totalAmount = 0, totalOrderCount = 0, totalServiceCount = 0

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${yearMonth}-${String(d).padStart(2, '0')}`
    if (dateStr > todayStr) break  
    const dayData = businessDays[dateStr]
    if (dayData) {
      dailyData.push({ date: dateStr, ...dayData })
      totalAmount += dayData.amount
      totalOrderCount += dayData.orderCount
      totalServiceCount += dayData.serviceCount
    }
  }

  return { dailyData, totalAmount, totalOrderCount, totalServiceCount }
}

export const workbenchHandlers: Record<string, (payload: Record<string, any>) => any> = {
  'staff.todayCommission': () => ({
    todayAmount: '3200.00',
    orderCount: 2,
    serviceCount: 3,
    storeTodayRevenue: '12800.00',
  }),

  'staff.monthlyCalendar': (payload) => {
    const today = new Date()
    const defaultYm = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const yearMonth = payload.yearMonth || defaultYm
    return buildMonthlyData(yearMonth)
  },

  'staff.todoList': () => ({
    pendingAppointmentCount: 3,
    pendingServiceCount: 2,
    pendingOfflineOrderCount: 1,
    pendingCreateOrderCount: 0,
  }),
}
