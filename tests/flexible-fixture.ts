import writeExcel from 'write-excel-file/node';
export function arbitraryWorkbook(
  quantity = '100',
  balance = '12,345.67',
  retirementSheet = 'Retirement',
  transactionDate?: string,
  obscureHeaders = false,
) {
  return writeExcel(
    [
      {
        sheet: retirementSheet,
        data: [
          ['Portfolio statement'],
          [
            'Ticker',
            'Units',
            'Avg. Cost',
            'Currency',
            'Exchange',
            'Security Type',
            'Cash Balance',
            ...(transactionDate ? ['Transaction date'] : []),
          ].map((label) => (obscureHeaders ? `Unrecognized ${label}` : label)),
          [
            'AAPL',
            quantity,
            '150',
            'USD',
            'NASDAQ',
            'Equity',
            '',
            ...(transactionDate ? [transactionDate] : []),
          ],
          ['CASH', '', '', 'USD', '', 'CASH', balance],
        ],
      },
      {
        sheet: 'Savings',
        data: [
          [
            'CCY',
            'Cash Amount',
            'Asset Class',
            'Security Symbol',
            'Quantity',
            'Average Price',
            'Exchange',
          ],
          ['CAD', '', 'ETF', 'XIU', '20', '30', 'TSX'],
          ['CAD', '(123.45)', 'CASH', 'CASH', '', '', ''],
        ],
      },
    ].map((s) => ({
      ...s,
      data: s.data.map((row) => row.map((value) => ({ type: String, value }))),
    })),
  ).toBuffer();
}

export function sevenAccountTabs() {
  return writeExcel(
    Array.from({ length: 7 }, (_, i) => ({
      sheet: `Choice Account ${i + 1}`,
      data: [
        ['Asset Class', 'Symbol', 'Quantity', 'Currency', 'Cash Balance'],
        ['STOCK', 'AAA', '2', 'USD', ''],
        ['CASH', 'CASH', '', 'USD', '100'],
      ].map((row) => row.map((value) => ({ type: String, value }))),
    })),
  ).toBuffer();
}
