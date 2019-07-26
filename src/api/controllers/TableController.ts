import database, { Database } from '@root/api/db'
import { HttpException, IMCRequest, IMCResponse, IUser } from '@root/api/types'
import {
  addToResponse,
  applyPKFilters,
  applyQueryFiltersSearch,
  catchMiddleware,
  filterVisibleTableColumns,
  getColumnsWithRelations,
  getTableConfig,
  hasAuthorization,
  nextAndReturn,
  runHook
} from '@root/api/utils'
import { normalize as normalizeData } from '@root/api/utils/data'
import { IColumnRelation, IManyToOneRelation, ITableInfo } from '@root/configGenerator'
import Bluebird from 'bluebird'
import Debug from 'debug'
import { NextFunction } from 'express'
import Knex from 'knex'
import metle from 'metle'

const debug = Debug('funfunzmc:controller-table')

interface IToRequestItem {
  values: Set<number>,
  key: string,
  display: string,
  foreignKeyColumn: string
}

interface IToRequest {
  [key: string]: IToRequestItem,
}

function toRequestBuilder(relation: IColumnRelation, columnName: string): IToRequestItem {
  return {
    values: new Set<number>(),
    key: relation.key,
    display: relation.display,
    foreignKeyColumn: columnName,
  }
}

class TableController {
  constructor() {
    debug('Created')
  }

  public getTableConfig(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_CONFIG = getTableConfig(req.params.table)
    const RESULT = {
      columns: TABLE_CONFIG.columns,
      name: TABLE_CONFIG.name,
      pk: TABLE_CONFIG.pk,
      verbose: TABLE_CONFIG.verbose,
      chips: TABLE_CONFIG.chips || [],
      itemTitle: TABLE_CONFIG.itemTitle,
      relations: TABLE_CONFIG.relations,
      actions: TABLE_CONFIG.actions,
    }

    if (!hasAuthorization(TABLE_CONFIG.roles, req.user)) {
      return catchMiddleware(next, new HttpException(401, 'Not authorized'))
    }
    addToResponse(res, 'results')(RESULT)
    return nextAndReturn(next)(RESULT)
  }

  public getTableData(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const ORDER = req.query.order || null
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)
    const COLUMNS = filterVisibleTableColumns(TABLE_CONFIG, 'main')

    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        return Promise.all([
          DB,
          runHook(TABLE_CONFIG, 'getTableData', 'before', req, res, DB),
        ])
      }
    ).then(
      ([DB, hookResult]) => {
        let QUERY = DB.select(COLUMNS).from(TABLE_NAME)
        QUERY = applyQueryFiltersSearch(QUERY, req.query, TABLE_CONFIG)

        if (ORDER) {
          const ORDER_OBJ = JSON.parse(ORDER)
          if (Array.isArray(ORDER_OBJ)) {
            QUERY.orderBy(ORDER_OBJ)
          } else {
            QUERY.orderBy(ORDER_OBJ.column, ORDER_OBJ.order)
          }
        }

        QUERY = this.paginate(QUERY, req.query.page , req.query.limit)

        if (hookResult) {
          if (hookResult.filter) {
            Object.keys(hookResult.filter).forEach(
              (column) => {
                if (Array.isArray(hookResult.filter[column])) {
                  QUERY.whereIn(column, hookResult.filter[column])
                }
              }
            )
          }
        }

        return Promise.all([
          QUERY,
          DB,
        ])
      }
    ).then(
      ([results, DB]) => {
        if (req.query.friendlyData) {
          return Promise.all([
            this.addVerboseRelatedData(results, TABLE_CONFIG, DB),
            DB,
          ])
        }
        return Promise.all([
          results,
          DB,
        ])
      }
    ).then(
      ([results, DB]) => {
        return runHook(TABLE_CONFIG, 'getTableData', 'after', req, res, DB, results)
      }
    ).then(
      addToResponse(res, 'results')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, err)
      }
    )
  }

  public getDistinctTableData(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)

    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        const columns: {
          toRequest: string[],
          toAdd: Array<{
            name: string,
            value: string[],
          }>
        } = {
          toRequest: [],
          toAdd: [],
        }
        req.query.columns.forEach(
          (column: string) => {
            if (metle.hasItem('distinct_' + column)) {
              columns.toAdd.push({
                name: column,
                value: metle.getItem('distinct_' + column),
              })
            } else {
              columns.toRequest.push(column)
            }
          }
        )
        let QUERY = DB(TABLE_NAME).distinct(columns.toRequest)
        QUERY = applyQueryFiltersSearch(QUERY, req.query, TABLE_CONFIG)
        return runHook(TABLE_CONFIG, 'getDistinctTableData', 'before', req, res, DB).then(
          (hookResult) => {
            if (hookResult) {
              if (hookResult.filter) {
                Object.keys(hookResult.filter).forEach(
                  (column) => {
                    if (Array.isArray(hookResult.filter[column])) {
                      QUERY.whereIn(column, hookResult.filter[column])
                    }
                  }
                )
              }
            }
            return Promise.all([DB, QUERY, columns.toAdd])
          }
        )
      }
    ).then(
      ([DB, queryResults, columnsToAdd]) => {
        const results = queryResults.reduce(
          (result, entry) => {
            const key = Object.keys(entry)[0]
            if (!result[key]) {
              result[key] = []
            }
            result[key].push(entry[key])
            return result
          },
          {}
        )

        Object.keys(results).forEach(
          (column: string) => {
            metle.setItem('distinct_' + column, results[column])
          }
        )

        columnsToAdd.forEach(
          (column) => {
            results[column.name] = column.value
          }
        )
        return runHook(TABLE_CONFIG, 'getDistinctTableData', 'after', req, res, DB, results)
      }
    ).then(
      addToResponse(res, 'results')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, new HttpException(500, err.message))
      }
    )
  }

  public getTableCount(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)

    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        let QUERY = DB(TABLE_NAME).select('*')
        QUERY = applyQueryFiltersSearch(QUERY, req.query, TABLE_CONFIG)
        return Promise.all([DB, QUERY])
      }
    ).then(
      ([DB, results]) => {
        return runHook(TABLE_CONFIG, 'getTableCount', 'after', req, res, DB, results)
      }
    ).then(
      addToResponse(res, 'count')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, err)
      }
    )
  }

  public getRowData(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)

    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        const requestedColumns = filterVisibleTableColumns(TABLE_CONFIG, 'detail')
        let QUERY = DB.select(requestedColumns).from(`${req.params.table}`)
        QUERY = applyPKFilters(QUERY, req.body, TABLE_CONFIG)
        return QUERY
      }
    ).then(
      (results) => {
        let manyToOneRelationQueries: Array<Bluebird<{}>> = []
        let manyToManyRelationQueries: Array<Bluebird<{}>> = []
        const result = results[0]
        if (req.query.includeRelations) {
          manyToOneRelationQueries = this.getManyToOneRelationQueries(TABLE_CONFIG, result)
          manyToManyRelationQueries = this.getManyToManyRelationQueries(TABLE_CONFIG, result)
        }

        return Promise.all([
          result,
          Promise.all(manyToOneRelationQueries),
          Promise.all(manyToManyRelationQueries),
        ])
      }
    ).then(
      this.mergeRelatedData
    ).then(
      (results) => {
        return runHook(TABLE_CONFIG, 'getRow', 'after', req, res, database.db, results)
      }
    ).then(
      addToResponse(res, 'results')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, err)
      }
    )
  }

  public insertRowData(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)
    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        const data = normalizeData(req.body.data, TABLE_CONFIG)
        return Promise.all([
          DB,
          runHook(TABLE_CONFIG, 'insertRow', 'before', req, res, DB, data),
        ])
      }
    ).then(
      ([DB, data]) => {
        return DB(req.params.table).insert(data)
      }
    ).then(
      (results) => {
        return runHook(TABLE_CONFIG, 'insertRow', 'after', req, res, database.db, results)
      }
    ).then(
      addToResponse(res, 'results')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, err)
      }
    )
  }

  public updateRowData(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)

    if (!req.body.data) {
      next(new HttpException(500, 'Missing data object'))
      return
    }
    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        const acceptedColumns: string[] = []
        TABLE_CONFIG.columns.forEach(
          (column) => {
            if (column.type === 'datetime') {
              req.body.data[column.name] = new Date(req.body.data[column.name] || null)
            }
            if (req.body.data[column.name] !== undefined) {
              acceptedColumns.push(column.name)
            }
          }
        )

        const newData = normalizeData(req.body.data, TABLE_CONFIG)
        return Promise.all([
          DB,
          runHook(TABLE_CONFIG, 'updateRow', 'before', req, res, DB, newData),
        ])
      }
    ).then(
      ([DB, data]) => {
        let QUERY = DB(TABLE_NAME)
        QUERY = applyPKFilters(QUERY, req.body, TABLE_CONFIG)
        return QUERY.update(data)
      }
    ).then(
      (results) => {
        return runHook(TABLE_CONFIG, 'updateRow', 'after', req, res, database.db, results)
      }
    ).then(
      addToResponse(res, 'results')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, err)
      }
    )
  }

  public deleteRowData(req: IMCRequest, res: IMCResponse, next: NextFunction) {
    const TABLE_NAME = req.params.table
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)

    return this.requirementsCheck(TABLE_CONFIG, req.user, database, next).then(
      (DB) => {
        return Promise.all([
          DB,
          runHook(TABLE_CONFIG, 'deleteRow', 'before', req, res, database.db),
        ])
      }
    ).then(
      ([DB]) => {
        let QUERY = DB(TABLE_NAME)
        QUERY = applyPKFilters(QUERY, req.body, TABLE_CONFIG)
        return QUERY.del()
      }
    ).then(
      (results) => {
        return runHook(TABLE_CONFIG, 'deleteRow', 'after', req, res, database.db, results)
      }
    ).then(
      addToResponse(res, 'results')
    ).then(
      nextAndReturn(next)
    ).catch(
      (err) => {
        catchMiddleware(next, err)
      }
    )
  }

  private paginate(query: Knex.QueryBuilder, page: string | number, limit: string | number) {
    let LIMIT = 10
    let PAGE_NUMBER = 0
    if (page) {
      PAGE_NUMBER = typeof page === 'string' ? parseInt(page, 10) : page
    }
    if (limit) {
      LIMIT = typeof limit === 'string' ? parseInt(limit, 10) : limit
    }

    if (LIMIT > 0) {
      query.offset((PAGE_NUMBER) * LIMIT).limit(LIMIT)
    }

    return query
  }

  private addVerboseRelatedData(results: any[], TABLE_CONFIG: ITableInfo, DB: Knex) {
    const toRequest: IToRequest = {}
    const COLUMNS_WITH_RELATIONS = getColumnsWithRelations(TABLE_CONFIG)
    results.forEach(
      (row: any, index: number) => {
        COLUMNS_WITH_RELATIONS.forEach(
          (column) => {
            if (!column.relation) {
              throw new HttpException(500, 'Column should have a relation')
            }
            const RELATION_TABLE_NAME = column.relation.table

            if (!toRequest[RELATION_TABLE_NAME]) {
              toRequest[RELATION_TABLE_NAME] = toRequestBuilder(column.relation, column.name)
            }

            toRequest[RELATION_TABLE_NAME].values.add(row[column.name])
          }
        )
      }
    )

    const relationQueries: Knex.QueryBuilder[] = []
    Object.keys(toRequest).forEach(
      (tableName) => {
        relationQueries.push(
          DB.select(toRequest[tableName].display, toRequest[tableName].key)
            .from(tableName)
            .whereIn(toRequest[tableName].key, Array.from(toRequest[tableName].values.values()))
        )
      }
    )

    return Promise.all<any[]>(relationQueries).then(
      (relationResults) => {
        const MATCHER: {
          [foreignKeyColumn: string]: {
            [value: string]: string
          }
        } = {}
        Object.values(toRequest).forEach(
          (requestedTable, index) => {
            const FOREIGN_KEY_COLUMN = requestedTable.foreignKeyColumn
            MATCHER[FOREIGN_KEY_COLUMN] = {}
            relationResults[index].forEach(
              (relationRow: any) => {
                const CURRENT_VALUE = relationRow[requestedTable.key]
                const VALUE_TO_DISPLAY = relationRow[requestedTable.display]
                MATCHER[FOREIGN_KEY_COLUMN][CURRENT_VALUE] = VALUE_TO_DISPLAY
              }
            )
          }
        )
        return results.map(
          (row: any) => {
            Object.values(toRequest).forEach(
              (requestedTable) => {
                const ROW_KEY = requestedTable.foreignKeyColumn
                row[ROW_KEY] = MATCHER[ROW_KEY][row[ROW_KEY]]
              }
            )
            return row
          }
        )
      }
    )
  }

  private requirementsCheck(
    tableConfig: ITableInfo,
    user: IUser | undefined,
    dbInstance: Database,
    next: (param?: any) => void
  ) {
    if (!hasAuthorization(tableConfig.roles, user)) {
      return Promise.reject(new HttpException(401, 'Not authorized'))
    }
    if (!dbInstance.db) {
      const ERROR = new HttpException(500, 'No database')
      catchMiddleware(next, ERROR)
      return Promise.reject(ERROR)
    }
    return Promise.resolve(dbInstance.db)
  }

  private getManyToOneRelationQueries(TABLE_CONFIG: ITableInfo, parentData: any) {
    const relationQueries: Array<Bluebird<{}>> = []
    if (TABLE_CONFIG.relations && TABLE_CONFIG.relations.manyToOne) {
      const MANY_TO_ONE = TABLE_CONFIG.relations.manyToOne
      const KEYS: string[] = Object.keys(MANY_TO_ONE)
      KEYS.forEach(
        (tableName) => {
          relationQueries.push(
            this.getRelatedRow(
              tableName,
              MANY_TO_ONE[tableName],
              parentData
            )
          )
        }
      )
    }

    return relationQueries
  }

  private getManyToManyRelationQueries(TABLE_CONFIG: ITableInfo, parentData: any) {
    let relationQueries: Array<Bluebird<{}>> = []
    if (TABLE_CONFIG.relations && TABLE_CONFIG.relations.manyToMany) {
      if (!database.db) {
        throw new HttpException(500, 'No database')
      }
      const DB = database.db
      relationQueries = TABLE_CONFIG.relations.manyToMany.map(
        (relation) => {
          return DB(relation.relationTable).select().where(relation.foreignKey, parentData[relation.localId]).then(
            (relationResult: any) => {
              return relationResult.map(
                (relationRow: any) => relationRow[relation.remoteForeignKey]
              )
            }
          ).then(
            (relationRemoteIds) => {
              return Promise.all([
                relation.remoteTable,
                DB(relation.remoteTable).select().whereIn(relation.remoteId, relationRemoteIds),
              ])
            }
          )
        }
      )
    }

    return relationQueries
  }

  private getRelatedRow(tableName: string, columnNames: IManyToOneRelation[], parentData: any) {
    if (!database.db) {
      throw new HttpException(500, 'No database')
    }
    const TABLE_NAME = tableName
    const TABLE_CONFIG = getTableConfig(TABLE_NAME)

    const requestedColumns = filterVisibleTableColumns(TABLE_CONFIG, 'detail').filter(
      (column) => !columnNames.find((relatedData) => relatedData.fk.indexOf(column) >= 0)
    )

    const QUERY = database.db.select(requestedColumns).from(tableName)

    columnNames.forEach(
      (columnName, index) => {
        index === 0
          ? QUERY.where(columnName.fk, parentData[columnName.target])
          : QUERY.andWhere(columnName.fk, parentData[columnName.target])
      }
    )
    return QUERY.then(
      (results) => ({
        results,
        tableName,
      })
    )
  }

  private mergeRelatedData([results, manyToOneRelations, manyToManyRelations]: any) {
    if (manyToOneRelations && manyToOneRelations.length) {
      manyToOneRelations.forEach(
        (relation: {tableName: string, results: any[]}) => {
          results[relation.tableName] = relation.results
        }
      )
    }

    if (manyToManyRelations && manyToManyRelations.length) {
      manyToManyRelations.forEach(
        ([verbose, relationsData]: [string, any[]]) => {
          results[verbose] = relationsData
        }
      )
    }

    return results
  }
}

export default TableController
