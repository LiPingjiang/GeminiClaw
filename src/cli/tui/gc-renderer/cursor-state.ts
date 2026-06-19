// Tracks where the terminal cursor should be shown after each render
export const cursor = { col: 0, row: -1, visible: false }

export function setCursor(col: number, row: number, visible: boolean): void {
  cursor.col = col
  cursor.row = row
  cursor.visible = visible
}
