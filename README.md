# sqlite-live-select
sqlite-live-select is a proposed Node.js package designed to emit events when SQLite query result sets change by monitoring the SQLite Write-Ahead Log (WAL) to track changes to relevant tables.

It is intended to function similarly to [@vlasky/mysql-live-select](https://github.com/vlasky/mysql-live-select), which works with MySQL and monitors the MySQL binlog to track changes to relevant tables.

## Proposed Components

1. **LiveSQLite**: The main class that handles database connections, WAL monitoring, and change processing.
2. **LiveSQLiteSelect**: Represents a live query, handling result set diffing and event emission.
3. **LiveSQLiteKeySelector**: Utility for specifying how to identify unique rows in result sets.
4. **LiveSQLiteError**: Custom error class for specific error handling.

## Proposed Dependencies

It is proposed to use the Node.js packages [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for database operations and [chokidar](https://github.com/paulmillr/chokidar) for watching the WAL file. It emits events as specified and implements the required methods like pause(), resume(), and end().
To use this package, you would typically do something like this:

## Example Usage
```
const { LiveSQLite, LiveSQLiteKeySelector } = require('sqlite-live-select');

const liveConnection = new LiveSQLite({ filename: 'path/to/your/database.sqlite' });

liveConnection.select(
  'SELECT * FROM players WHERE id = ?',
  [11],
  LiveSQLiteKeySelector.Columns(['id']),
  [{
    table: 'players',
    condition: (row, newRow) => row.id === 11 || (newRow && newRow.id === 11)
  }]
).on('update', (diff, data) => {
  console.log('Updated data:', data);
});
```

## Proposed Design Decisions

### 1. WAL-based Change Detection
- **Decision**: Use SQLite's Write-Ahead Log (WAL) for change detection.
- **Rationale**: WAL provides a low-overhead method to track database changes without modifying the database schema or adding triggers. The WAL is updated even when the SQLite database is written to externally.

### 2. Selective Table Caching
- **Decision**: Cache only tables used in live queries.
- **Rationale**: Minimize memory usage by avoiding unnecessary caching of unused tables.

### 3. In-Memory Row Caching
- **Decision**: Maintain an in-memory cache of rows for tracked tables.
- **Rationale**: Allows for efficient comparison between old and new row states without additional database queries, as well as allowing the old row state to be retrieved.

### 4. Configurable Column Caching
- **Decision**: Allow users to specify which columns to include or exclude from caching for each table.
- **Rationale**: Further optimize memory usage by caching only necessary columns.

### 5. Connection Pooling
- **Decision**: Implement optional connection pooling for SELECT queries.
- **Rationale**: Improve performance for applications with high query volumes.

### 6. Minimal Update Interval
- **Decision**: Implement a configurable minimum interval between updates.
- **Rationale**: Prevent excessive update frequency in high-change environments.

### 7. JSON Support
- **Decision**: Automatically parse TEXT fields as JSON when possible.
- **Rationale**: Provide seamless support for JSON data stored in TEXT columns.

### 8. Custom Error Handling
- **Decision**: Implement a custom LiveSQLiteError class with error codes.
- **Rationale**: Provide detailed and specific error information for better error handling and debugging.

## Key Processes

1. **Initialization**:
   - Set up database connection(s)
   - Initialize WAL watcher
   - Set up data structures for caching and tracking

2. **Live Query Creation**:
   - Prepare SQL statement
   - Cache relevant tables and columns
   - Create LiveSQLiteSelect instance
   - Execute initial query and store results

3. **WAL Processing**:
   - Monitor WAL file for changes
   - Parse WAL frames to identify changed rows
   - Update in-memory cache with changes
   - Notify affected queries

4. **Query Update**:
   - Re-execute query when notified of relevant changes
   - Diff new results against previous results
   - Emit update event with changes

## Performance Considerations

- Selective caching to minimize memory usage
- Configurable update intervals to manage update frequency
- Connection pooling for high-volume scenarios
- Efficient WAL parsing to minimize overhead

## Limitations and Future Improvements

- No handling of index pages (potential for unnecessary updates)
- Potential for high memory usage with large tables or many tracked tables
- Could benefit from more granular WAL change tracking
- May need optimizations for very high-frequency update scenarios
