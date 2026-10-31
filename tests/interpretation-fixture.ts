import writeExcel from 'write-excel-file/node';
export function expiryWorkbook() {
  return writeExcel([
    {
      sheet: 'Expiry RRSP',
      data: [
        [
          'Asset class',
          'Symbol',
          'Description',
          'Quantity',
          'Multiplier',
          'Deliverable',
        ],
        ['OPT', 'ABC', '12.50C 10-30', '-1', '100', 'STANDARD'],
        ['CASH', 'CASH', 'Cash', '250', '', ''],
      ].map((row) => row.map((value) => ({ type: String, value }))),
    },
  ]).toBuffer();
}
export function interpretationWorkbook(
  quantity = '7',
  cash = '4123.45',
  cost = '17.25',
  reverse = false,
  description = '12.50C 10-30',
) {
  const positions = [
    ['COMMON', 'AAA', 'Alpha shares', quantity, cost, 'USD'],
    ['OPT', 'ABC', description, '-1', '0.5', 'USD'],
  ];
  if (reverse) positions.reverse();
  return writeExcel([
    {
      sheet: 'Rules RRSP',
      data: [
        [
          'Asset class',
          'Symbol',
          'Description',
          'Quantity',
          'Cost per share',
          'Currency',
        ],
        ...positions,
        ['CASH', 'CASH', 'Cash', cash, '', 'USD'],
      ].map((row) => row.map((value) => ({ type: String, value }))),
    },
  ]).toBuffer();
}
