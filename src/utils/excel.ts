/**
 * Excel 导入 / 导出工具（基于 exceljs，浏览器端运行）
 * - 导出：生成 xlsx 并触发下载
 * - 导入：解析上传文件为对象数组（以首行中文表头作为键）
 */
import ExcelJS from 'exceljs'

interface Col { header: string; key: string }

/** 导出为 Excel 并下载 */
export async function exportXlsx(rows: Record<string, any>[], cols: Col[], filename: string) {
  const wb = new ExcelJS.Workbook()
  wb.creator = '园区综合运维管理平台'
  wb.created = new Date()

  const ws = wb.addWorksheet(filename.slice(0, 28), {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultColWidth: 16 }
  })

  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: 18 }))

  // 表头样式
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
  ws.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5F8B' }
  }
  ws.getRow(1).height = 24
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }

  rows.forEach((r) => ws.addRow(r))

  ws.eachRow((row, i) => {
    if (i === 1) return
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE5E9ED' } },
        left: { style: 'thin', color: { argb: 'FFE5E9ED' } },
        bottom: { style: 'thin', color: { argb: 'FFE5E9ED' } },
        right: { style: 'thin', color: { argb: 'FFE5E9ED' } }
      }
    })
  })

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

/** 解析上传的 Excel，返回以中文表头为键的对象数组 */
export async function readXlsx(file: File): Promise<Record<string, any>[]> {
  const wb = new ExcelJS.Workbook()
  const buf = await file.arrayBuffer()
  await wb.xlsx.load(buf)

  const ws = wb.worksheets[0]
  if (!ws) throw new Error('文件中没有工作表')

  const headers: string[] = []
  ws.getRow(1).eachCell((cell, i) => {
    headers[i] = String(cell.value ?? '').trim()
  })

  const list: Record<string, any>[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const obj: Record<string, any> = {}
    let empty = true
    headers.forEach((h, i) => {
      if (!h) return
      const v = row.getCell(i).value
      const text = v && typeof v === 'object' && 'text' in (v as any)
        ? (v as any).text
        : v instanceof Date
          ? v.toISOString().slice(0, 10)
          : v
      obj[h] = text ?? ''
      if (text !== '' && text != null) empty = false
    })
    if (!empty) list.push(obj)
  })
  return list
}
